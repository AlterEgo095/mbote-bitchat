/*
  Warnings (REVUS — Étape 0 rupture ADM, cf. docs/proofs/ADM-rupture.md) :

  - Les 4 colonnes legacy (adminKey/hiddenBy/handledBy/suspendedBy) sont
    SUPPRIMÉES volontairement : elles contenaient le secret ADMIN_API_KEY en
    clair (risque R-1 de l'audit). La valeur du secret n'est JAMAIS copiée —
    les lignes pré-rupture reçoivent actorLabel = 'legacy' (constante),
    adminUserId = NULL. Vérification préalable prod (opérateur) :
    SELECT COUNT(*) FROM ModerationAction WHERE adminKey IS NOT NULL; etc.
    Attendu 0 (aucune action admin n'a jamais réussi en prod — clé jamais
    câblée au conteneur, cf. ADM-audit §0.3). Plan conditionnel si ≠ 0 :
    post-migration, rattacher à system : UPDATE ModerationAction SET
    adminUserId = 1 WHERE actorLabel = 'legacy'; (idempotent, auditable).
  - actorLabel NOT NULL : rempli par la constante 'legacy' ci-dessous
    (l'INSERT généré automatiquement ne le faisait pas → corrigé).
*/
-- CreateTable
CREATE TABLE "AdminUser" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "totpSecret" TEXT,
    "totpEnrolled" BOOLEAN NOT NULL DEFAULT false,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" DATETIME
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adminUserId" INTEGER NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    CONSTRAINT "AdminSession_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdminAudit" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "actorId" INTEGER NOT NULL,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "justification" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AdminUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ModerationAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adminUserId" INTEGER,
    "actorLabel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT,
    "reportIds" TEXT,
    "meta" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModerationAction_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ModerationAction" ("action", "actorLabel", "createdAt", "id", "meta", "reason", "reportIds", "targetId", "targetKind") SELECT "action", 'legacy', "createdAt", "id", "meta", "reason", "reportIds", "targetId", "targetKind" FROM "ModerationAction";
DROP TABLE "ModerationAction";
ALTER TABLE "new_ModerationAction" RENAME TO "ModerationAction";
CREATE INDEX "ModerationAction_targetKind_targetId_idx" ON "ModerationAction"("targetKind", "targetId");
CREATE INDEX "ModerationAction_createdAt_idx" ON "ModerationAction"("createdAt");
CREATE INDEX "ModerationAction_adminUserId_idx" ON "ModerationAction"("adminUserId");
CREATE TABLE "new_Post" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "geohash" TEXT,
    "precision" INTEGER,
    "parentId" TEXT,
    "signature" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'web',
    "meshHops" INTEGER NOT NULL DEFAULT 0,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "hiddenAt" DATETIME,
    "hiddenById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Post_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Post_hiddenById_fkey" FOREIGN KEY ("hiddenById") REFERENCES "AdminUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Post" ("authorId", "content", "createdAt", "geohash", "hiddenAt", "id", "likeCount", "meshHops", "origin", "parentId", "precision", "replyCount", "signature") SELECT "authorId", "content", "createdAt", "geohash", "hiddenAt", "id", "likeCount", "meshHops", "origin", "parentId", "precision", "replyCount", "signature" FROM "Post";
DROP TABLE "Post";
ALTER TABLE "new_Post" RENAME TO "Post";
CREATE UNIQUE INDEX "Post_signature_key" ON "Post"("signature");
CREATE INDEX "Post_geohash_precision_idx" ON "Post"("geohash", "precision");
CREATE INDEX "Post_authorId_idx" ON "Post"("authorId");
CREATE INDEX "Post_parentId_idx" ON "Post"("parentId");
CREATE INDEX "Post_parentId_createdAt_idx" ON "Post"("parentId", "createdAt");
CREATE INDEX "Post_createdAt_idx" ON "Post"("createdAt");
CREATE TABLE "new_Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reporterKey" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "handledAt" DATETIME,
    "handledById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Report_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "AdminUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Report" ("createdAt", "details", "handledAt", "id", "reason", "reporterKey", "status", "targetId", "targetKind") SELECT "createdAt", "details", "handledAt", "id", "reason", "reporterKey", "status", "targetId", "targetKind" FROM "Report";
DROP TABLE "Report";
ALTER TABLE "new_Report" RENAME TO "Report";
CREATE INDEX "Report_status_createdAt_idx" ON "Report"("status", "createdAt");
CREATE INDEX "Report_targetKind_targetId_idx" ON "Report"("targetKind", "targetId");
CREATE UNIQUE INDEX "Report_reporterKey_targetKind_targetId_key" ON "Report"("reporterKey", "targetKind", "targetId");
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pubkey" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "bio" TEXT,
    "ecdhPub" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "botPriv" TEXT,
    "suspendedAt" DATETIME,
    "suspendedById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_suspendedById_fkey" FOREIGN KEY ("suspendedById") REFERENCES "AdminUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_User" ("bio", "botPriv", "createdAt", "ecdhPub", "id", "isBot", "nickname", "pubkey", "suspendedAt", "updatedAt") SELECT "bio", "botPriv", "createdAt", "ecdhPub", "id", "isBot", "nickname", "pubkey", "suspendedAt", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_pubkey_key" ON "User"("pubkey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE INDEX "AdminUser_role_idx" ON "AdminUser"("role");

-- CreateIndex
CREATE INDEX "AdminSession_adminUserId_idx" ON "AdminSession"("adminUserId");

-- CreateIndex
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- CreateIndex
CREATE INDEX "AdminAudit_actorId_idx" ON "AdminAudit"("actorId");

-- CreateIndex
CREATE INDEX "AdminAudit_action_idx" ON "AdminAudit"("action");

-- CreateIndex
CREATE INDEX "AdminAudit_createdAt_idx" ON "AdminAudit"("createdAt");

-- CreateIndex
CREATE INDEX "AdminAudit_targetType_targetId_idx" ON "AdminAudit"("targetType", "targetId");

-- ─────────────────────────────────────────────────────────────────────────────
-- ADM Étape 0 — seed du pseudo-user system (id fixe 1, role 'system')
-- Représente le CLI de purge (secret machine ADMIN_API_KEY) — JAMAIS de login :
-- passwordHash NULL + (code) tout login d'un compte role='system' est refusé.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "AdminUser" ("id", "email", "role", "totpEnrolled", "createdAt") VALUES (1, 'system@mbote.internal', 'system', 0, CURRENT_TIMESTAMP);

-- ─────────────────────────────────────────────────────────────────────────────
-- ADM Étape 0 — AdminAudit APPEND-ONLY (décision §3.2/R-8 de l'audit)
-- Triggers au niveau MOTEUR SQLite : aucun client (Prisma inclus) ne peut
-- contourner. Contournement résiduel = une migration future qui dropperait
-- ces triggers → garde : schema-guard.yml + check CI sqlite_master + relecture
-- super-admin obligatoire de toute migration touchant AdminAudit.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TRIGGER "admin_audit_no_update"
BEFORE UPDATE ON "AdminAudit"
BEGIN
    SELECT RAISE(FAIL, 'AdminAudit is append-only (UPDATE forbidden)');
END;

CREATE TRIGGER "admin_audit_no_delete"
BEFORE DELETE ON "AdminAudit"
BEGIN
    SELECT RAISE(FAIL, 'AdminAudit is append-only (DELETE forbidden)');
END;
