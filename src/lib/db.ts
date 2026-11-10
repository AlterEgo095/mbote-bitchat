import { existsSync } from 'fs'
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
// ⚠️ GARDE existsSync : le PRAGMA OUVRE le fichier à l'import — sur un
// harnais de test qui recrée sa DB dans beforeAll, cette ouverture précoce
// fait parler le client à l'INODE SUPPRIMÉ (P2021 « table does not exist »,
// constat runner Étape 10). Si le fichier n'existe pas encore : skip — le
// premier boot du serveur (db.ts du process serveur) posera WAL, persistant.
//
// ── Clarification 1 (D1+C2) — AUCUNE opération de config DB silencieuse ─────
// Le bug $executeRawUnsafe (PRAGMA rejeté SANS lever) est une CLASSE de bug :
// une PRAGMA/DDL au boot qui échoue en silence ruine la prod sans trace.
// Règle désormais appliquée ici (documentée dans DEV-SETUP §db) :
//   1. toute opération de config DB au boot VALIDE son résultat — le retour
//      de $queryRawUnsafe est inspecté, un mode inattendu = throw ;
//   2. un échec de transport (SQLITE_BUSY, fichier illisible) = rejet
//      propagé — JAMAIS absorbé par un simple console.error.
// Tradeoff assumé : fail-fast (unhandled rejection → crash loud du process,
// redémarrage container + log visible) plutôt que continuation silencieuse
// sur une DB mal configurée (contenu en DELETE → convois de verrous, cf.
// constat Étape 10). Le PRAGMA étant idempotent et persistant, un boot qui
// réussit une fois ne retombe jamais en arrière.
const dbFilePath = process.env.DATABASE_URL?.replace(/^file:/, "").split("?")[0]

/**
 * Valide le retour d'un PRAGMA journal_mode — pure et testable.
 * Clarification 1 : un résultat inattendu DOIT lever, jamais passer en silence.
 */
export function assertBootPragmaResult(
  rows: Array<{ journal_mode: string } | Record<string, unknown>>
): void {
  const mode = (rows as Array<{ journal_mode?: string }>)[0]?.journal_mode
  if (typeof mode !== "string" || mode.toLowerCase() !== "wal") {
    throw new Error(
      `[db] PRAGMA journal_mode a retourné « ${mode ?? "aucune ligne"} » au lieu de « wal » — opération de config DB ratée au boot (refus de continuer en silence, cf. DEV-SETUP §db)`
    )
  }
}

/**
 * Pose et VÉRIFIE le journal_mode=WAL au boot. Toute anomalie (transport OU
 * résultat inattendu) rejette — l'appelant boot applique le fail-fast.
 * Testable avec un client dédié (tests/db-boot-pragma.test.ts).
 */
export async function verifyBootPragmas(client: PrismaClient = db): Promise<void> {
  const rows = await client.$queryRawUnsafe<Array<{ journal_mode: string }>>(
    "PRAGMA journal_mode=WAL"
  )
  assertBootPragmaResult(rows)
}

if (!dbFilePath || existsSync(dbFilePath)) {
  verifyBootPragmas().catch((e) => {
    console.error(
      "[db] Échec de la validation PRAGMA au boot — ARRÊT (fail-fast, une DB mal configurée ne doit jamais servir du trafic en silence) :",
      e instanceof Error ? e.message : e
    )
    // rethrow → rejet non géré = crash loud du process (container restart +
    // journal visible). Ne JAMAIS remplacer par un swallow : c'est exactement
    // la classe de bug qu'Étape 10 a attrapée (4 instances/module en silence).
    throw e
  })
}
