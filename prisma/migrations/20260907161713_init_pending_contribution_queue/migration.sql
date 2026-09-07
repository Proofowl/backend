-- CreateTable
CREATE TABLE "PendingContribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "githubIdHash" TEXT NOT NULL,
    "githubUserId" TEXT NOT NULL,
    "prHash" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "issueId" BIGINT NOT NULL DEFAULT 0,
    "complexity" INTEGER NOT NULL DEFAULT 0,
    "verificationJson" TEXT NOT NULL,
    "selfMergeFlagged" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'WAITING_FOR_WALLET_LINK',
    "statusNote" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingContribution_prHash_key" ON "PendingContribution"("prHash");

-- CreateIndex
CREATE INDEX "PendingContribution_status_idx" ON "PendingContribution"("status");

-- CreateIndex
CREATE INDEX "PendingContribution_githubIdHash_idx" ON "PendingContribution"("githubIdHash");
