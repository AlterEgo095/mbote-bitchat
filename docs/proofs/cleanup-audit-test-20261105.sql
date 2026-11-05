-- ============================================================================
-- Mbote Mesh — Nettoyage SQL du résidu d'audit du 2026-11-05
-- (identités `audit-test-20261105-*` — cf. docs/proofs/PROD-VERIFICATION-2026-11-05.md §5)
-- ============================================================================
-- Deux chemins d'exécution opérateur (pas d'accès SSH côté audit) :
--
--  A) CHEMIN RECOMMANDÉ — script validé localement contre le schéma des
--     migrations 0001–0003 (dry-run par défaut, preuves avant/après, integrity_check) :
--       scp scripts/cleanup-audit-test.ts root@95.111.226.63:/tmp/
--       ssh root@95.111.226.63 'docker exec -i mbote-mesh bun run -' < scripts/cleanup-audit-test.ts
--       ssh root@95.111.226.63 'docker exec -i -e CLEANUP_APPLY=1 mbote-mesh bun run -' < scripts/cleanup-audit-test.ts
--
--  B) CE FICHIER — pour une session sqlite3 manuelle (copier-coller) :
--       ssh root@95.111.226.63
--       docker exec -i mbote-mesh bun -e 'const{Database}=require("bun:sqlite");const db=new Database(process.env.DATABASE_URL.replace(/^file:/,""));db.exec(require("fs").readFileSync(0,"utf8"));' < docs/proofs/cleanup-audit-test-20261105.sql
--     (l'image oven/bun n'a pas de CLI sqlite3 — bun:sqlite lit le SQL par stdin)
--     ⚠️ Via ce one-liner, `db.exec` exécute tout mais n'AFFICHE pas les
--     SELECT : la preuve affichée (avant/après + integrity_check) vient du
--     CHEMIN A. Le chemin B s'arrête sur la première erreur (transactions).
--
-- ATTENTION : les sections 1–5 suppriment des lignes. Relire deux fois.
-- HORS PORTÉE (par conception A3) : ModerationAction (journal d'audit — les
-- traces subsistent même après purge ; 0 attendu, ne jamais supprimer à l'aveugle)
-- et ReplayGuard (aucun lien vers les identités, auto-expiration < 24 h).
-- ============================================================================

-- ── 0) ÉTAT AVANT — preuve (sortie brute attendue : users_test=8, dms_test=8) ──
SELECT 'users_test'            AS metric, COUNT(*) AS value FROM User WHERE nickname LIKE 'audit-test-%';
SELECT 'dms_test'              AS metric, COUNT(*) AS value FROM DirectMessage
  WHERE msgId LIKE 'audit-%' OR msgId LIKE 'mesh-audit-%'
     OR senderKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%')
     OR recipientKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');
SELECT 'trusted_keys'          AS metric, COUNT(*) AS value FROM TrustedKey
  WHERE ownerKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%')
     OR peerKey  IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');
SELECT 'peer_blocks'           AS metric, COUNT(*) AS value FROM PeerBlock
  WHERE blockerKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%')
     OR blockedKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');
SELECT 'replay_counters'       AS metric, COUNT(*) AS value FROM ReplayCounter
  WHERE senderKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%')
     OR recipientKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');
SELECT 'reports_test'          AS metric, COUNT(*) AS value FROM Report
  WHERE reporterKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');
SELECT 'moderation_actions_total' AS metric, COUNT(*) AS value FROM ModerationAction; -- attendu 0 (ne pas supprimer)

BEGIN;

-- ── 1) DMs de test (entre identités audit, ou msgId préfixé audit-/mesh-audit-) ──
DELETE FROM DirectMessage
 WHERE msgId LIKE 'audit-%' OR msgId LIKE 'mesh-audit-%'
    OR senderKey    IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%')
    OR recipientKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');

-- ── 2) Confiance A2 / blocage A3 / compteurs A1 liés aux identités de test ──
DELETE FROM TrustedKey
 WHERE ownerKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%')
    OR peerKey   IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');

DELETE FROM PeerBlock
 WHERE blockerKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%')
    OR blockedKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');

DELETE FROM ReplayCounter
 WHERE senderKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%')
    OR recipientKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');

-- ── 3) Signalements éventuels émis par des identités de test (0 attendu) ──
DELETE FROM Report
 WHERE reporterKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');

-- ── 4) Identités de test (en dernier) ──
DELETE FROM User WHERE nickname LIKE 'audit-test-%';

COMMIT;

-- ── 5) ÉTAT APRÈS — preuve (attendu : 0 partout ; integrity_check = ok) ──
SELECT 'users_test_FINAL'      AS metric, COUNT(*) AS value FROM User WHERE nickname LIKE 'audit-test-%';
SELECT 'dms_test_FINAL'        AS metric, COUNT(*) AS value FROM DirectMessage
  WHERE msgId LIKE 'audit-%' OR msgId LIKE 'mesh-audit-%'
     OR senderKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%')
     OR recipientKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');
SELECT 'trusted_keys_FINAL'    AS metric, COUNT(*) AS value FROM TrustedKey
  WHERE ownerKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%')
     OR peerKey  IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');
SELECT 'peer_blocks_FINAL'     AS metric, COUNT(*) AS value FROM PeerBlock
  WHERE blockerKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%')
     OR blockedKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');
SELECT 'reports_test_FINAL'    AS metric, COUNT(*) AS value FROM Report
  WHERE reporterKey IN (SELECT pubkey FROM User WHERE nickname LIKE 'audit-test-%');
SELECT 'moderation_actions_FINAL' AS metric, COUNT(*) AS value FROM ModerationAction; -- attendu 0
PRAGMA integrity_check;
SELECT 'users_total'           AS metric, COUNT(*) AS value FROM User;  -- attendu : 3 (base réelle)
SELECT 'dms_total'             AS metric, COUNT(*) AS value FROM DirectMessage; -- attendu : 0
