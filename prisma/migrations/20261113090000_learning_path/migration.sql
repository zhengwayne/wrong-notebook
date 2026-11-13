-- CreateTable
CREATE TABLE "KnowledgeMastery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "studentKey" TEXT NOT NULL,
    "knowledgePoint" TEXT NOT NULL,
    "pKnown" REAL NOT NULL DEFAULT 0.3,
    "retrievability" REAL NOT NULL DEFAULT 1,
    "stabilityDays" REAL NOT NULL DEFAULT 1,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "lastCorrect" BOOLEAN,
    "lastObservedAt" DATETIME,
    "dueAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "KnowledgeMastery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LearningPath" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "studentKey" TEXT NOT NULL,
    "studentName" TEXT NOT NULL,
    "classId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "evidenceHash" TEXT NOT NULL,
    "planReason" TEXT,
    "aiSuggestCount" INTEGER NOT NULL DEFAULT 0,
    "aiSuggestedAt" DATETIME,
    "plannedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LearningPath_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LearningPathStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pathId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "knowledgePoints" TEXT NOT NULL,
    "errorItemIds" TEXT,
    "variantRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "dueAt" DATETIME,
    "href" TEXT,
    "teacherNote" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LearningPathStep_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "LearningPath" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeMastery_userId_studentKey_knowledgePoint_key" ON "KnowledgeMastery"("userId", "studentKey", "knowledgePoint");

-- CreateIndex
CREATE INDEX "KnowledgeMastery_userId_studentKey_idx" ON "KnowledgeMastery"("userId", "studentKey");

-- CreateIndex
CREATE INDEX "KnowledgeMastery_userId_dueAt_idx" ON "KnowledgeMastery"("userId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "LearningPath_userId_studentKey_key" ON "LearningPath"("userId", "studentKey");

-- CreateIndex
CREATE INDEX "LearningPath_userId_classId_idx" ON "LearningPath"("userId", "classId");

-- CreateIndex
CREATE INDEX "LearningPathStep_pathId_position_idx" ON "LearningPathStep"("pathId", "position");
