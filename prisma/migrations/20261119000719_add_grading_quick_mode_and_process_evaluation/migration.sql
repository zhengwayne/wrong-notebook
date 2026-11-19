-- AlterTable
ALTER TABLE "GradingResult" ADD COLUMN "bbox" TEXT;
ALTER TABLE "GradingResult" ADD COLUMN "comment" TEXT;
ALTER TABLE "GradingResult" ADD COLUMN "confidence" REAL;

-- AlterTable
ALTER TABLE "ParentPaper" ADD COLUMN "attitudeLevel" TEXT;
ALTER TABLE "ParentPaper" ADD COLUMN "handwritingLevel" TEXT;
ALTER TABLE "ParentPaper" ADD COLUMN "neatnessLevel" TEXT;
ALTER TABLE "ParentPaper" ADD COLUMN "parentComment" TEXT;
ALTER TABLE "ParentPaper" ADD COLUMN "processTags" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GradingKeyQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'objective',
    "maxScore" REAL NOT NULL DEFAULT 1,
    "answer" TEXT NOT NULL DEFAULT '',
    "answerSource" TEXT NOT NULL DEFAULT 'manual',
    "acceptedAnswers" TEXT,
    "questionText" TEXT,
    "knowledgePoints" TEXT,
    CONSTRAINT "GradingKeyQuestion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "GradingTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_GradingKeyQuestion" ("acceptedAnswers", "answer", "id", "knowledgePoints", "maxScore", "number", "order", "questionText", "taskId", "type") SELECT "acceptedAnswers", "answer", "id", "knowledgePoints", "maxScore", "number", "order", "questionText", "taskId", "type" FROM "GradingKeyQuestion";
DROP TABLE "GradingKeyQuestion";
ALTER TABLE "new_GradingKeyQuestion" RENAME TO "GradingKeyQuestion";
CREATE INDEX "GradingKeyQuestion_taskId_order_idx" ON "GradingKeyQuestion"("taskId", "order");
CREATE TABLE "new_GradingSubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "studentId" TEXT,
    "detectedName" TEXT,
    "detectedClass" TEXT,
    "detectedStudentNo" TEXT,
    "matchStatus" TEXT,
    "matchConfidence" REAL,
    "matchReason" TEXT,
    "matchCandidates" TEXT,
    "images" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewBucket" TEXT NOT NULL DEFAULT 'yellow',
    "handwritingLevel" TEXT,
    "neatnessLevel" TEXT,
    "attitudeLevel" TEXT,
    "processTags" TEXT,
    "visualAlerts" TEXT,
    "teacherComment" TEXT,
    "shareTokenHash" TEXT,
    "shareExpiresAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 0,
    "totalScore" REAL,
    "error" TEXT,
    "confirmedAt" DATETIME,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GradingSubmission_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "GradingTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GradingSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "GradingStudent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_GradingSubmission" ("confirmedAt", "createdAt", "detectedClass", "detectedName", "detectedStudentNo", "error", "id", "images", "importedCount", "matchCandidates", "matchConfidence", "matchReason", "matchStatus", "status", "studentId", "taskId", "totalScore", "updatedAt", "version") SELECT "confirmedAt", "createdAt", "detectedClass", "detectedName", "detectedStudentNo", "error", "id", "images", "importedCount", "matchCandidates", "matchConfidence", "matchReason", "matchStatus", "status", "studentId", "taskId", "totalScore", "updatedAt", "version" FROM "GradingSubmission";
DROP TABLE "GradingSubmission";
ALTER TABLE "new_GradingSubmission" RENAME TO "GradingSubmission";
CREATE UNIQUE INDEX "GradingSubmission_shareTokenHash_key" ON "GradingSubmission"("shareTokenHash");
CREATE INDEX "GradingSubmission_taskId_createdAt_idx" ON "GradingSubmission"("taskId", "createdAt");
CREATE INDEX "GradingSubmission_studentId_idx" ON "GradingSubmission"("studentId");
CREATE TABLE "new_GradingTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL DEFAULT '数学',
    "taskMode" TEXT NOT NULL DEFAULT 'standard',
    "scoringMode" TEXT NOT NULL DEFAULT 'numeric',
    "deadline" DATETIME,
    "allowSelfSubmit" BOOLEAN NOT NULL DEFAULT false,
    "submitTokenHash" TEXT,
    "examPaperId" TEXT,
    "keyImageUrl" TEXT,
    "extraClassIds" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GradingTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GradingTask_classId_fkey" FOREIGN KEY ("classId") REFERENCES "GradingClass" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_GradingTask" ("classId", "createdAt", "examPaperId", "extraClassIds", "id", "keyImageUrl", "subjectName", "title", "updatedAt", "userId") SELECT "classId", "createdAt", "examPaperId", "extraClassIds", "id", "keyImageUrl", "subjectName", "title", "updatedAt", "userId" FROM "GradingTask";
DROP TABLE "GradingTask";
ALTER TABLE "new_GradingTask" RENAME TO "GradingTask";
CREATE UNIQUE INDEX "GradingTask_submitTokenHash_key" ON "GradingTask"("submitTokenHash");
CREATE INDEX "GradingTask_userId_createdAt_idx" ON "GradingTask"("userId", "createdAt");
CREATE INDEX "GradingTask_classId_idx" ON "GradingTask"("classId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
