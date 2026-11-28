-- AlterTable
ALTER TABLE "User" ADD COLUMN "reviewAlgorithmVersion" TEXT NOT NULL DEFAULT 'ebbinghaus-v1';

-- CreateTable
CREATE TABLE "ItemMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "learnerId" TEXT,
    "scopeKey" TEXT NOT NULL DEFAULT 'self',
    "errorItemId" TEXT NOT NULL,
    "stability" REAL NOT NULL DEFAULT 1,
    "difficulty" REAL NOT NULL DEFAULT 5,
    "lastReviewAt" DATETIME,
    "dueAt" DATETIME NOT NULL,
    "reps" INTEGER NOT NULL DEFAULT 0,
    "lapses" INTEGER NOT NULL DEFAULT 0,
    "algorithmVersion" TEXT NOT NULL DEFAULT 'fsrs-v1',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ItemMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ItemMemory_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "Learner" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ItemMemory_errorItemId_fkey" FOREIGN KEY ("errorItemId") REFERENCES "ErrorItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ItemMemory_userId_scopeKey_dueAt_idx" ON "ItemMemory"("userId", "scopeKey", "dueAt");

-- CreateIndex
CREATE INDEX "ItemMemory_errorItemId_idx" ON "ItemMemory"("errorItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemMemory_userId_scopeKey_errorItemId_algorithmVersion_key" ON "ItemMemory"("userId", "scopeKey", "errorItemId", "algorithmVersion");
