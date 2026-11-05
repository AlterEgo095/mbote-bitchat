/*
  Warnings:

  - Added the required column `tokenHash` to the `AdminSession` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN "totpLastCounter" INTEGER;

-- CreateTable
CREATE TABLE "AdminRecoveryCode" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "adminUserId" INTEGER NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" DATETIME,
    "usedIp" TEXT,
    "usedUserAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminRecoveryCode_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AdminSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adminUserId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "revokedReason" TEXT,
    CONSTRAINT "AdminSession_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_AdminSession" ("adminUserId", "createdAt", "csrfToken", "expiresAt", "id", "ip", "lastSeenAt", "revokedAt", "userAgent") SELECT "adminUserId", "createdAt", "csrfToken", "expiresAt", "id", "ip", "lastSeenAt", "revokedAt", "userAgent" FROM "AdminSession";
DROP TABLE "AdminSession";
ALTER TABLE "new_AdminSession" RENAME TO "AdminSession";
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");
CREATE INDEX "AdminSession_adminUserId_idx" ON "AdminSession"("adminUserId");
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AdminRecoveryCode_adminUserId_idx" ON "AdminRecoveryCode"("adminUserId");
