-- CreateTable
CREATE TABLE "PendingAction" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "actionType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "payloadJson" TEXT,
    "justification" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdById" INTEGER NOT NULL,
    "createdBySessionId" TEXT NOT NULL,
    "approvedById" INTEGER,
    "approvedAt" DATETIME,
    "executedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "PendingAction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PendingAction_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "AdminUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pubkey" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "bio" TEXT,
    "ecdhPub" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "botPriv" TEXT,
    "suspendedAt" DATETIME,
    "suspendedUntil" DATETIME,
    "suspendedById" INTEGER,
    "bannedAt" DATETIME,
    "bannedById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_suspendedById_fkey" FOREIGN KEY ("suspendedById") REFERENCES "AdminUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "User_bannedById_fkey" FOREIGN KEY ("bannedById") REFERENCES "AdminUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_User" ("bio", "botPriv", "createdAt", "ecdhPub", "id", "isBot", "nickname", "pubkey", "suspendedAt", "suspendedById", "suspendedUntil", "updatedAt") SELECT "bio", "botPriv", "createdAt", "ecdhPub", "id", "isBot", "nickname", "pubkey", "suspendedAt", "suspendedById", "suspendedUntil", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_pubkey_key" ON "User"("pubkey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PendingAction_status_idx" ON "PendingAction"("status");

-- CreateIndex
CREATE INDEX "PendingAction_createdById_idx" ON "PendingAction"("createdById");

-- CreateIndex
CREATE INDEX "PendingAction_expiresAt_idx" ON "PendingAction"("expiresAt");

-- CreateIndex
CREATE INDEX "PendingAction_targetType_targetId_idx" ON "PendingAction"("targetType", "targetId");
