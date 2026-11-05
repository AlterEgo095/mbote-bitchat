-- AlterTable
ALTER TABLE "DirectMessage" ADD COLUMN "msgId" TEXT;
ALTER TABLE "DirectMessage" ADD COLUMN "seq" INTEGER;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN "hiddenAt" DATETIME;
ALTER TABLE "Post" ADD COLUMN "hiddenBy" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "suspendedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "suspendedBy" TEXT;

-- CreateTable
CREATE TABLE "ReplayGuard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'dm',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReplayCounter" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "senderKey" TEXT NOT NULL,
    "recipientKey" TEXT NOT NULL,
    "epoch" BIGINT NOT NULL,
    "lastSeq" BIGINT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TrustedKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerKey" TEXT NOT NULL,
    "peerKey" TEXT NOT NULL,
    "ecdhPubPinned" TEXT NOT NULL,
    "safetyNumber" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'unverified',
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" DATETIME,
    "changedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reporterKey" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "handledAt" DATETIME,
    "handledBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PeerBlock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "blockerKey" TEXT NOT NULL,
    "blockedKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ModerationAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adminKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT,
    "reportIds" TEXT,
    "meta" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ReplayGuard_expiresAt_idx" ON "ReplayGuard"("expiresAt");

-- CreateIndex
CREATE INDEX "ReplayCounter_senderKey_recipientKey_idx" ON "ReplayCounter"("senderKey", "recipientKey");

-- CreateIndex
CREATE INDEX "ReplayCounter_epoch_idx" ON "ReplayCounter"("epoch");

-- CreateIndex
CREATE INDEX "TrustedKey_ownerKey_idx" ON "TrustedKey"("ownerKey");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedKey_ownerKey_peerKey_key" ON "TrustedKey"("ownerKey", "peerKey");

-- CreateIndex
CREATE INDEX "Report_status_createdAt_idx" ON "Report"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Report_targetKind_targetId_idx" ON "Report"("targetKind", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Report_reporterKey_targetKind_targetId_key" ON "Report"("reporterKey", "targetKind", "targetId");

-- CreateIndex
CREATE INDEX "PeerBlock_blockerKey_idx" ON "PeerBlock"("blockerKey");

-- CreateIndex
CREATE UNIQUE INDEX "PeerBlock_blockerKey_blockedKey_key" ON "PeerBlock"("blockerKey", "blockedKey");

-- CreateIndex
CREATE INDEX "ModerationAction_targetKind_targetId_idx" ON "ModerationAction"("targetKind", "targetId");

-- CreateIndex
CREATE INDEX "ModerationAction_createdAt_idx" ON "ModerationAction"("createdAt");

-- CreateIndex
CREATE INDEX "DirectMessage_msgId_idx" ON "DirectMessage"("msgId");

