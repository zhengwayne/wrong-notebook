-- CreateTable
CREATE TABLE "Learner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gradingStudentId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Learner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Learner_gradingStudentId_fkey" FOREIGN KEY ("gradingStudentId") REFERENCES "GradingStudent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LearnerBackfillAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previousLearnerId" TEXT,
    "newLearnerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- AlterTable
ALTER TABLE "ErrorItem" ADD COLUMN "learnerId" TEXT;

-- AlterTable
ALTER TABLE "PracticeRecord" ADD COLUMN "learnerId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Learner_gradingStudentId_key" ON "Learner"("gradingStudentId");

-- CreateIndex
CREATE INDEX "Learner_userId_kind_idx" ON "Learner"("userId", "kind");

-- CreateIndex
CREATE INDEX "LearnerBackfillAudit_batchId_idx" ON "LearnerBackfillAudit"("batchId");

-- CreateIndex
CREATE INDEX "LearnerBackfillAudit_entityType_entityId_idx" ON "LearnerBackfillAudit"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ErrorItem_learnerId_idx" ON "ErrorItem"("learnerId");

-- CreateIndex
CREATE INDEX "PracticeRecord_learnerId_idx" ON "PracticeRecord"("learnerId");
