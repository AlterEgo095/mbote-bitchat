/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Nettoyage du résidu d'audit PROD-VERIFICATION-2026-11-05
 *  Identités `audit-test-20261105-*` + données liées (A1/A2/A3, §2 de l'audit).
 * ─────────────────────────────────────────────────────────────────────────────
 *  DRY-RUN PAR DÉFAUT (aucune écriture). Pour appliquer : CLEANUP_APPLY=1.
 *
 *  Exécution opérateur (l'audit n'a pas d'accès SSH au VPS) — le script est
 *  passé par stdin (`bun run -`) car l'image oven/bun n'embarque ni `sqlite3`
 *  CLI ni /app/scripts :
 *
 *    # 1) AVANT — dry-run, preuve « avant » (aucune écriture) :
 *    ssh root@95.111.226.63 'docker exec -i mbote-mesh bun run -' \
 *      < scripts/cleanup-audit-test.ts
 *
 *    # 2) APPLICATION — preuve « après » (écritures, transaction unique) :
 *    ssh root@95.111.226.63 'docker exec -i -e CLEANUP_APPLY=1 mbote-mesh bun run -' \
 *      < scripts/cleanup-audit-test.ts
 *
 *  Cible (résidu exact 0) :
 *    - User            WHERE nickname LIKE 'audit-test-%'            (8 attendus)
 *    - DirectMessage   entre ces identités (ou msgId préfixé « audit-… » / « mesh-audit-… »)  (8)
 *    - TrustedKey      owner/peer ∈ identités test                   (paires A2)
 *    - PeerBlock       blocker/blocked ∈ identités test              (annulé via API à l'audit S3, 0 attendu)
 *    - ReplayCounter   sender/recipient ∈ identités test             (garde A1)
 *    - Report          reporter ∈ identités test                     (0 attendu — tous les reports de test ont échoué avant création)
 *  HORS PORTée (par conception, cf. docs/proofs/A3-moderation.md) :
 *    - ModerationAction : journal d'audit de modération — les traces SUBSISTENT
 *      même après purge (exigence A3). 0 ligne attendue ; si > 0 : investiguer,
 *      ne pas supprimer à l'aveugle.
 *    - ReplayGuard : sans lien vers les identités (id = SHA-256 du tuple) et
 *      auto-expiration < 24 h — laissé à l'expiration automatique.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Database } from "bun:sqlite";

const APPLY = process.env.CLEANUP_APPLY === "1";
const PREFIX = "audit-test-%"; // couvre audit-test-20261105-* et tout audit futur marqué

const rawPath = process.env.DATABASE_URL || "file:/app/db/custom.db";
const dbPath = rawPath.replace(/^file:/, "");
const db = new Database(dbPath); // lecture/écriture seulement en APPLY ; SQLite ouvre à la demande

const count = (sql: string): number =>
  (db.query(sql).get() as { c: number }).c;

const testUserPubkeys = `SELECT pubkey FROM User WHERE nickname LIKE '${PREFIX}'`;

const BEFORE = {
  users_test: count(`SELECT COUNT(*) c FROM User WHERE nickname LIKE '${PREFIX}'`),
  dms_test: count(
    `SELECT COUNT(*) c FROM DirectMessage WHERE msgId LIKE 'audit-%' OR msgId LIKE 'mesh-audit-%'
       OR senderKey IN (${testUserPubkeys}) OR recipientKey IN (${testUserPubkeys})`
  ),
  trusted_keys: count(
    `SELECT COUNT(*) c FROM TrustedKey WHERE ownerKey IN (${testUserPubkeys}) OR peerKey IN (${testUserPubkeys})`
  ),
  peer_blocks: count(
    `SELECT COUNT(*) c FROM PeerBlock WHERE blockerKey IN (${testUserPubkeys}) OR blockedKey IN (${testUserPubkeys})`
  ),
  replay_counters: count(
    `SELECT COUNT(*) c FROM ReplayCounter WHERE senderKey IN (${testUserPubkeys}) OR recipientKey IN (${testUserPubkeys})`
  ),
  reports_test: count(
    `SELECT COUNT(*) c FROM Report WHERE reporterKey IN (${testUserPubkeys})`
  ),
  moderation_actions_total: count(`SELECT COUNT(*) c FROM ModerationAction`),
};

console.log(`── Nettoyage résidu d'audit — DB: ${dbPath}`);
console.log(`── Mode : ${APPLY ? "APPLY (écritures)" : "DRY-RUN (aucune écriture — CLEANUP_APPLY=1 pour appliquer)"}`);
console.log("── AVANT (SELECT COUNT(*) bruts) :");
for (const [k, v] of Object.entries(BEFORE)) console.log(`   ${k.padEnd(26)} = ${v}`);

if (APPLY) {
  db.exec("BEGIN");
  try {
    db.exec(
      `DELETE FROM DirectMessage WHERE msgId LIKE 'audit-%' OR msgId LIKE 'mesh-audit-%'
         OR senderKey IN (${testUserPubkeys}) OR recipientKey IN (${testUserPubkeys});`
    );
    db.exec(
      `DELETE FROM TrustedKey WHERE ownerKey IN (${testUserPubkeys}) OR peerKey IN (${testUserPubkeys});`
    );
    db.exec(
      `DELETE FROM PeerBlock WHERE blockerKey IN (${testUserPubkeys}) OR blockedKey IN (${testUserPubkeys});`
    );
    db.exec(
      `DELETE FROM ReplayCounter WHERE senderKey IN (${testUserPubkeys}) OR recipientKey IN (${testUserPubkeys});`
    );
    db.exec(`DELETE FROM Report WHERE reporterKey IN (${testUserPubkeys});`);
    db.exec(`DELETE FROM User WHERE nickname LIKE '${PREFIX}';`);
    db.exec("COMMIT");
    console.log("── Transaction COMMITée (6 DELETE) ✅");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("── ROLLBACK — erreur :", e);
    process.exit(1);
  }
} else if (BEFORE.users_test === 0 && BEFORE.dms_test === 0 && BEFORE.trusted_keys === 0 && BEFORE.peer_blocks === 0 && BEFORE.replay_counters === 0 && BEFORE.reports_test === 0) {
  console.log("── DRY-RUN : résidu déjà à 0 — rien à faire (passer en APPLY inutile).");
} else {
  console.log("── DRY-RUN : relancer avec CLEANUP_APPLY=1 pour supprimer les lignes ci-dessus.");
}

const AFTER = {
  users_test: count(`SELECT COUNT(*) c FROM User WHERE nickname LIKE '${PREFIX}'`),
  dms_test: count(
    `SELECT COUNT(*) c FROM DirectMessage WHERE msgId LIKE 'audit-%' OR msgId LIKE 'mesh-audit-%'
       OR senderKey IN (${testUserPubkeys}) OR recipientKey IN (${testUserPubkeys})`
  ),
  trusted_keys: count(
    `SELECT COUNT(*) c FROM TrustedKey WHERE ownerKey IN (${testUserPubkeys}) OR peerKey IN (${testUserPubkeys})`
  ),
  peer_blocks: count(
    `SELECT COUNT(*) c FROM PeerBlock WHERE blockerKey IN (${testUserPubkeys}) OR blockedKey IN (${testUserPubkeys})`
  ),
  replay_counters: count(
    `SELECT COUNT(*) c FROM ReplayCounter WHERE senderKey IN (${testUserPubkeys}) OR recipientKey IN (${testUserPubkeys})`
  ),
  reports_test: count(
    `SELECT COUNT(*) c FROM Report WHERE reporterKey IN (${testUserPubkeys})`
  ),
  moderation_actions_total: count(`SELECT COUNT(*) c FROM ModerationAction`),
};

console.log("── APRÈS (SELECT COUNT(*) bruts) :");
for (const [k, v] of Object.entries(AFTER)) console.log(`   ${k.padEnd(26)} = ${v}`);

const integrity = (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
const usersTotal = count("SELECT COUNT(*) c FROM User");
const dmsTotal = count("SELECT COUNT(*) c FROM DirectMessage");
console.log(`── PRAGMA integrity_check : ${integrity}`);
console.log(`── État de la base : users(total)=${usersTotal} · dms(total)=${dmsTotal} · attendu réel : users=3 · dms=0`);

const residueZero =
  AFTER.users_test === 0 &&
  AFTER.dms_test === 0 &&
  AFTER.trusted_keys === 0 &&
  AFTER.peer_blocks === 0 &&
  AFTER.replay_counters === 0 &&
  AFTER.reports_test === 0;

if (residueZero && integrity === "ok") {
  console.log("✅ RÉSIDU = 0 — intégrité OK");
} else {
  console.error("❌ RÉSIDU NON NUL (ou intégrité KO) — voir comptes APRÈS ci-dessus");
  process.exit(1);
}
