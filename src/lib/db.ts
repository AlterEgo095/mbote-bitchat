import { PrismaClient } from '@prisma/client'

// ── connection_limit=1 FORCÉ (Étape 10 — constat charge light, §E preuve) ───
// CONSTAT (build prod, 50 requêtes admin mixtes étagées) : avec le pool par
// défaut (~5 connexions sur 2 CPU), les transactions interactives (itx) et
// les requêtes globales se disputent les connexions ET le verrou d'écriture
// SQLite — convois de verrous, timeouts en cascade (P2028/P1008, durées
// quantifiées à 5 s = busy_timeout par défaut) : 26/50 échecs observés.
// Le MÊME trafic avec `connection_limit=1` : 50/50 en 451 ms (max 170 ms) —
// TOUT est mis en file FIFO au pool : zéro busy-wait, zéro famine d'itx,
// zéro verrou tenu en attente. Les 100 lectures parallèles /audit passent en
// ~400-800 ms sérialisées (< 2 s requis). Débit lu ≈ 250 req/s — très au-delà
// du palier 1 (SCALE-ARCHITECTURE : SQLite = un seul conteneur ; palier 2 =
// Postgres). Le mutex d'écriture applicatif (write-mutex.ts) reste en place :
// il évite d'IMMOBILISER la seule connexion pendant l'attente d'un écrivain.
function withConnectionLimit(raw: string | undefined): string | undefined {
  if (!raw) return raw
  if (/(^|&)connection_limit=/.test(raw.split('?')[1] ?? '')) return raw
  return raw + (raw.includes('?') ? '&' : '?') + 'connection_limit=1'
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: {
      db: { url: withConnectionLimit(process.env.DATABASE_URL) },
    },
    log: ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ── WAL au démarrage (Étape 10 — constat charge light) ──────────────────────
// SQLite en journal_mode=DELETE (défaut après `prisma migrate deploy`) fait
// bloquer le COMMIT des écrivains par TOUT lecteur ouvert (verrou EXCLUSIVE
// requis). En WAL, les lecteurs ne bloquent plus l'écrivain. `journal_mode`
// est PERSISTANT au niveau FICHIER : idempotent à chaque boot, il suffit au
// premier démarrage (local disk — jamais de FS réseau, cf. §8
// SCALE-ARCHITECTURE : SQLite = palier 1, un seul conteneur).
// ⚠️ PRAGMA journal_mode est illégal DANS une transaction ET retourne une
// ligne (le nouveau mode) → $queryRawUnsafe (executeRawUnsafe rejette :
// « Execute returned results » — constat Étape 10, 4 instances de module par
// process ont échoué silencieusement avant le fix). Idempotent, hors tx.
void db
  .$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode=WAL')
  .then((r) => {
    if (process.env.MBOTE_DB_PRAGMA_LOG === '1')
      console.log(`[db] journal_mode=${r[0]?.journal_mode ?? '?'} (WAL attendu)`)
  })
  .catch((e) => {
    console.error('[db] PRAGMA journal_mode=WAL a échoué (contenu en DELETE — contention possible) :', e instanceof Error ? e.message : e)
  })
