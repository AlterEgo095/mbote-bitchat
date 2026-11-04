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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("bio", "botPriv", "createdAt", "ecdhPub", "id", "isBot", "nickname", "pubkey", "updatedAt") SELECT "bio", "botPriv", "createdAt", "ecdhPub", "id", "isBot", "nickname", "pubkey", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_pubkey_key" ON "User"("pubkey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

