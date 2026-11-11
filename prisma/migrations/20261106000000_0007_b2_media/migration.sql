-- B2 — médias chiffrés E2EE (socle B1 activé) : table Media (additive)
CREATE TABLE "Media" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "objectKey" TEXT NOT NULL,
    "ownerPubkey" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "plainBytes" INTEGER NOT NULL,
    "sha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" DATETIME
);
CREATE UNIQUE INDEX "Media_objectKey_key" ON "Media"("objectKey");
CREATE INDEX "Media_ownerPubkey_createdAt_idx" ON "Media"("ownerPubkey", "createdAt");
CREATE INDEX "Media_status_createdAt_idx" ON "Media"("status", "createdAt");
