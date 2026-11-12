-- CreateTable
CREATE TABLE "VariantRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "language" TEXT NOT NULL DEFAULT 'zh',
    "targetDifficulty" TEXT,
    "requestedCount" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT,
    "errorItemId" TEXT,
    "studentId" TEXT,
    "classId" TEXT,
    "subjectId" TEXT,
    "examPaperId" TEXT,
    "inputSnapshot" TEXT,
    "weaknessProfile" TEXT,
    "topicSuggestion" TEXT,
    "totalLatencyMs" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "cost" REAL,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "VariantRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VariantRun_errorItemId_fkey" FOREIGN KEY ("errorItemId") REFERENCES "ErrorItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VariantRun_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "GradingStudent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VariantRun_classId_fkey" FOREIGN KEY ("classId") REFERENCES "GradingClass" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VariantRun_examPaperId_fkey" FOREIGN KEY ("examPaperId") REFERENCES "ExamPaper" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VariantItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "plan" TEXT,
    "questionText" TEXT,
    "answerText" TEXT,
    "analysis" TEXT,
    "figureSvg" TEXT,
    "knowledgePoints" TEXT,
    "plannedDifficulty" TEXT,
    "checkedDifficulty" TEXT,
    "difficultyConsistent" BOOLEAN,
    "verification" TEXT,
    "similarity" REAL,
    "similarTo" TEXT,
    "sourceItemId" TEXT,
    "practiceRecordId" TEXT,
    "examQuestionId" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VariantItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "VariantRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VariantItem_practiceRecordId_fkey" FOREIGN KEY ("practiceRecordId") REFERENCES "PracticeRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VariantItem_examQuestionId_fkey" FOREIGN KEY ("examQuestionId") REFERENCES "ExamQuestion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VariantStageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "itemId" TEXT,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "cost" REAL,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VariantStageLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "VariantRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VariantStageLog_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "VariantItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "educationStage" TEXT,
    "enrollmentYear" INTEGER,
    "gradeRecognitionMode" TEXT NOT NULL DEFAULT 'fixed',
    "fixedGradeSemester" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "confirmBeforeImport" BOOLEAN NOT NULL DEFAULT false,
    "questionDuplicateThreshold" REAL NOT NULL DEFAULT 90,
    "masteryThreshold" INTEGER NOT NULL DEFAULT 50,
    "variantPipelineEnabled" BOOLEAN NOT NULL DEFAULT true,
    "enableGeogebra" BOOLEAN NOT NULL DEFAULT false,
    "enableSvgAnimation" BOOLEAN NOT NULL DEFAULT true,
    "themePreference" TEXT NOT NULL DEFAULT 'system'
);
INSERT INTO "new_User" ("confirmBeforeImport", "createdAt", "educationStage", "email", "enableGeogebra", "enableSvgAnimation", "enrollmentYear", "fixedGradeSemester", "gradeRecognitionMode", "id", "isActive", "masteryThreshold", "name", "password", "questionDuplicateThreshold", "role", "themePreference", "updatedAt") SELECT "confirmBeforeImport", "createdAt", "educationStage", "email", "enableGeogebra", "enableSvgAnimation", "enrollmentYear", "fixedGradeSemester", "gradeRecognitionMode", "id", "isActive", "masteryThreshold", "name", "password", "questionDuplicateThreshold", "role", "themePreference", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "VariantRun_userId_startedAt_idx" ON "VariantRun"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "VariantRun_errorItemId_idx" ON "VariantRun"("errorItemId");

-- CreateIndex
CREATE INDEX "VariantRun_studentId_idx" ON "VariantRun"("studentId");

-- CreateIndex
CREATE INDEX "VariantRun_classId_idx" ON "VariantRun"("classId");

-- CreateIndex
CREATE UNIQUE INDEX "VariantItem_practiceRecordId_key" ON "VariantItem"("practiceRecordId");

-- CreateIndex
CREATE INDEX "VariantItem_runId_index_idx" ON "VariantItem"("runId", "index");

-- CreateIndex
CREATE INDEX "VariantItem_status_idx" ON "VariantItem"("status");

-- CreateIndex
CREATE INDEX "VariantStageLog_runId_createdAt_idx" ON "VariantStageLog"("runId", "createdAt");

