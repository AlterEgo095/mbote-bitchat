-- ─────────────────────────────────────────────────────────────────────────────
-- 0011_d2_sybil — Sybil phase 0 (directive 2026-11-13)
--  · User : réputation + plafonds quotidiens dénormalisés + challenge PoW consommé
--  · Post : flag de crédit de réputation (sweep paresseux > 24 h sans report)
--  · PowSpent : anti-rejeu PoW global (PK challenge)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN "reputationScore" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "flaggedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "postsToday" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "dmsToday" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "usageDay" TEXT;
ALTER TABLE "User" ADD COLUMN "powChallenge" TEXT;
ALTER TABLE "Post" ADD COLUMN "reputationRewarded" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "PowSpent" (
    "challenge" TEXT NOT NULL,
    "consumedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PowSpent_pkey" PRIMARY KEY ("challenge")
);

CREATE TABLE "FollowCredit" (
    "followerId" TEXT NOT NULL,
    "followingId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FollowCredit_pkey" PRIMARY KEY ("followerId", "followingId")
);
