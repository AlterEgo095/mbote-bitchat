/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  D1 — SEED de la preuve recherche (à exécuter APRÈS `prisma migrate deploy`,
 *       AVANT le démarrage du serveur de preuve)
 * ─────────────────────────────────────────────────────────────────────────────
 *   DATABASE_URL="file:$ROOT/db/d1-search-proof.db" bun scripts/d1-search-seed.ts
 *
 *  Crée :
 *   • 3 utilisateurs (alice/bob/suspended) — bob a une VRAIE clé ECDH P-256
 *     (le navigateur scellera un DM vers lui) ;
 *   • posts publics (kinshasa, école/diacritiques, 5×paginword) ;
 *   • un post d'auteur suspendu (motif-suspendu) — exclu À LA LECTURE ;
 *   • un post à masquer + un post à supprimer PAR LE TEST (triggers FTS) ;
 *   • un DM (bob→alice) dont le ciphertext CONTIENT littéralement « secret » —
 *     une recherche serveur naïve le trouverait ; la nôtre ne doit JAMAIS le
 *     retourner (le serveur ne recherche pas les DM) ;
 *   • 10 000 posts de benchmark (bwbench) — recherche < 200 ms exigée.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({ log: [] });

function b64url(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("base64url");
}

async function generateEcdhPub(): Promise<string> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return b64url(raw);
}

async function main() {
  // garde : seed idempotent (rejouabilité de la preuve)
  const existing = await db.user.count();
  if (existing > 0) {
    console.log(JSON.stringify({ skipped: "db non vide", users: existing }));
    return;
  }

  const alice = await db.user.create({
    data: {
      pubkey: "d1-seed-alice-pubkey",
      nickname: "Alice Recherche",
      bio: "compte de preuve D1",
    },
  });
  const bobEcdh = await generateEcdhPub();
  const bob = await db.user.create({
    data: {
      pubkey: "d1-seed-bob-pubkey",
      nickname: "Bob Recherche",
      bio: "pair DM de preuve D1 (clé ECDH réelle)",
      ecdhPub: bobEcdh,
    },
  });
  const sus = await db.user.create({
    data: {
      pubkey: "d1-seed-suspended-pubkey",
      nickname: "Auteur Suspendu",
      suspendedAt: new Date(), // suspension ACTIVE (suspendedUntil null = ∞)
    },
  });

  await db.post.createMany({
    data: [
      { authorId: alice.id, content: "Marché central de Kinshasa — fruits frais ce matin, prix corrects" },
      { authorId: alice.id, content: "L'école communautaire du quartier ouvre gratuitement samedi" },
      ...Array.from({ length: 5 }, (_, i) => ({
        authorId: alice.id,
        content: `paginword numéro ${i + 1} du test de pagination recherche`,
      })),
      { authorId: sus.id, content: "motif-suspendu contenu unique d'un auteur suspendu" },
      { authorId: alice.id, content: "motif-cache contenu qui sera masqué par la modération" },
      { authorId: alice.id, content: "motif-supprime contenu qui sera supprimé par le test" },
    ],
  });

  // DM au ciphertext PIÉGÉ : contient littéralement « secret » — le serveur ne
  // doit JAMAIS le retourner (frontière E2EE : les DM ne sont pas recherchés)
  await db.directMessage.create({
    data: {
      senderKey: bob.pubkey,
      recipientKey: alice.pubkey,
      iv: "d1-seed-iv",
      ciphertext: "raw-ciphertext:secret-plan-intercepted",
    },
  });

  // 10 000 posts de benchmark — createMany déclenche les triggers FTS par ligne
  const TOTAL = 10_000;
  const CHUNK = 500;
  for (let c = 0; c < TOTAL / CHUNK; c++) {
    await db.post.createMany({
      data: Array.from({ length: CHUNK }, (_, i) => ({
        authorId: alice.id,
        content: `bwbench mot commun numéro ${c * CHUNK + i} remplissage du benchmark de recherche plein texte`,
      })),
    });
  }

  const posts = await db.post.count();
  const fts = await db.$queryRawUnsafe<Array<{ c: bigint }>>(
    "SELECT count(*) AS c FROM PostFTS"
  );
  console.log(
    JSON.stringify({
      users: 3,
      posts,
      postFTS: Number(fts[0].c),
      bobEcdhPub: bobEcdh.slice(0, 12) + "…",
      dmTrap: "raw-ciphertext:secret-plan-intercepted",
    })
  );
}

main()
  .catch((e) => {
    console.error("seed D1 échoué:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
