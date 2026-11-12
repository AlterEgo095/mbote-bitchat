-- C4 — groupes privés MLS (RFC 9420) : annuaire + relais de ciphertext opaque
-- migration additive (aucune colonne modifiée sur les modèles existants)

CREATE TABLE "MlsKeyPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userKey" TEXT NOT NULL,
    "keyPackage" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MlsKeyPackage_userKey_createdAt_idx" ON "MlsKeyPackage"("userKey", "createdAt");

CREATE TABLE "Group" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "mlsGroupId" TEXT NOT NULL,
    "creatorKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "Group_mlsGroupId_key" ON "Group"("mlsGroupId");
CREATE INDEX "Group_creatorKey_idx" ON "Group"("creatorKey");

CREATE TABLE "GroupMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "userKey" TEXT NOT NULL,
    "mlsLeafIndex" INTEGER,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" DATETIME,
    CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GroupMember_groupId_userKey_key" ON "GroupMember"("groupId", "userKey");
CREATE INDEX "GroupMember_userKey_idx" ON "GroupMember"("userKey");

CREATE TABLE "GroupMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "senderKey" TEXT NOT NULL,
    "mlsEpoch" BIGINT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GroupMessage_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "GroupMessage_groupId_createdAt_idx" ON "GroupMessage"("groupId", "createdAt");

CREATE TABLE "GroupEnvelope" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetKey" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GroupEnvelope_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "GroupEnvelope_groupId_createdAt_idx" ON "GroupEnvelope"("groupId", "createdAt");
