-- 迁移前审计并解绑悬空 learnerId，确保外键重建后通过 foreign_key_check 且不丢失任何错题或练习
INSERT INTO "LearnerBackfillAudit" ("id", "batchId", "userId", "entityType", "entityId", "action", "previousLearnerId", "newLearnerId", "createdAt")
SELECT
    'fk-ei-' || "id",
    'migration:20261118020000_add_learner_foreign_keys',
    "userId",
    'errorItem',
    "id",
    'unlink_orphan',
    "learnerId",
    NULL,
    CURRENT_TIMESTAMP
FROM "ErrorItem"
WHERE "learnerId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Learner" WHERE "Learner"."id" = "ErrorItem"."learnerId");

UPDATE "ErrorItem"
SET "learnerId" = NULL
WHERE "learnerId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Learner" WHERE "Learner"."id" = "ErrorItem"."learnerId");

INSERT INTO "LearnerBackfillAudit" ("id", "batchId", "userId", "entityType", "entityId", "action", "previousLearnerId", "newLearnerId", "createdAt")
SELECT
    'fk-pr-' || "id",
    'migration:20261118020000_add_learner_foreign_keys',
    "userId",
    'practiceRecord',
    "id",
    'unlink_orphan',
    "learnerId",
    NULL,
    CURRENT_TIMESTAMP
FROM "PracticeRecord"
WHERE "learnerId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Learner" WHERE "Learner"."id" = "PracticeRecord"."learnerId");

UPDATE "PracticeRecord"
SET "learnerId" = NULL
WHERE "learnerId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Learner" WHERE "Learner"."id" = "PracticeRecord"."learnerId");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ErrorItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shortId" TEXT,
    "userId" TEXT NOT NULL,
    "subjectId" TEXT,
    "originalImageUrl" TEXT NOT NULL,
    "ocrText" TEXT,
    "questionText" TEXT,
    "answerText" TEXT,
    "analysis" TEXT,
    "wrongAnswerText" TEXT,
    "mistakeAnalysis" TEXT,
    "mistakeStatus" TEXT,
    "knowledgePoints" TEXT,
    "geogebraCommands" TEXT,
    "svgAnimation" TEXT,
    "svgAnimationEn" TEXT,
    "source" TEXT,
    "errorType" TEXT,
    "userNotes" TEXT,
    "masteryLevel" INTEGER NOT NULL DEFAULT 0,
    "gradeSemester" TEXT,
    "paperLevel" TEXT,
    "difficultyStars" INTEGER,
    "hasFigure" BOOLEAN NOT NULL DEFAULT false,
    "figureSvg" TEXT,
    "lastPractice" TEXT,
    "masteryProbability" REAL,
    "masteryReason" TEXT,
    "masterySource" TEXT,
    "masteryEvaluatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "learnerId" TEXT,
    "provenanceId" TEXT,
    CONSTRAINT "ErrorItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ErrorItem_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ErrorItem_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "Learner" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ErrorItem" ("analysis", "answerText", "createdAt", "difficultyStars", "errorType", "figureSvg", "geogebraCommands", "gradeSemester", "hasFigure", "id", "knowledgePoints", "lastPractice", "learnerId", "masteryEvaluatedAt", "masteryLevel", "masteryProbability", "masteryReason", "masterySource", "mistakeAnalysis", "mistakeStatus", "ocrText", "originalImageUrl", "paperLevel", "provenanceId", "questionText", "shortId", "source", "subjectId", "svgAnimation", "svgAnimationEn", "updatedAt", "userId", "userNotes", "wrongAnswerText") SELECT "analysis", "answerText", "createdAt", "difficultyStars", "errorType", "figureSvg", "geogebraCommands", "gradeSemester", "hasFigure", "id", "knowledgePoints", "lastPractice", "learnerId", "masteryEvaluatedAt", "masteryLevel", "masteryProbability", "masteryReason", "masterySource", "mistakeAnalysis", "mistakeStatus", "ocrText", "originalImageUrl", "paperLevel", "provenanceId", "questionText", "shortId", "source", "subjectId", "svgAnimation", "svgAnimationEn", "updatedAt", "userId", "userNotes", "wrongAnswerText" FROM "ErrorItem";
DROP TABLE "ErrorItem";
ALTER TABLE "new_ErrorItem" RENAME TO "ErrorItem";
CREATE UNIQUE INDEX "ErrorItem_shortId_key" ON "ErrorItem"("shortId");
CREATE INDEX "ErrorItem_userId_createdAt_idx" ON "ErrorItem"("userId", "createdAt");
CREATE INDEX "ErrorItem_subjectId_idx" ON "ErrorItem"("subjectId");
CREATE INDEX "ErrorItem_learnerId_idx" ON "ErrorItem"("learnerId");
CREATE TABLE "new_PracticeRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "subject" TEXT,
    "difficulty" TEXT,
    "isCorrect" BOOLEAN,
    "errorItemId" TEXT,
    "result" TEXT,
    "questionText" TEXT,
    "answerText" TEXT,
    "analysis" TEXT,
    "wrongAnswerText" TEXT,
    "mistakeAnalysis" TEXT,
    "originalImageUrl" TEXT,
    "figureSvg" TEXT,
    "source" TEXT NOT NULL DEFAULT 'practice',
    "examQuestionId" TEXT,
    "learnerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PracticeRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PracticeRecord_errorItemId_fkey" FOREIGN KEY ("errorItemId") REFERENCES "ErrorItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PracticeRecord_examQuestionId_fkey" FOREIGN KEY ("examQuestionId") REFERENCES "ExamQuestion" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PracticeRecord_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "Learner" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PracticeRecord" ("analysis", "answerText", "createdAt", "difficulty", "errorItemId", "examQuestionId", "figureSvg", "id", "isCorrect", "learnerId", "mistakeAnalysis", "originalImageUrl", "questionText", "result", "source", "subject", "userId", "wrongAnswerText") SELECT "analysis", "answerText", "createdAt", "difficulty", "errorItemId", "examQuestionId", "figureSvg", "id", "isCorrect", "learnerId", "mistakeAnalysis", "originalImageUrl", "questionText", "result", "source", "subject", "userId", "wrongAnswerText" FROM "PracticeRecord";
DROP TABLE "PracticeRecord";
ALTER TABLE "new_PracticeRecord" RENAME TO "PracticeRecord";
CREATE INDEX "PracticeRecord_errorItemId_createdAt_idx" ON "PracticeRecord"("errorItemId", "createdAt");
CREATE INDEX "PracticeRecord_examQuestionId_idx" ON "PracticeRecord"("examQuestionId");
CREATE INDEX "PracticeRecord_userId_createdAt_idx" ON "PracticeRecord"("userId", "createdAt");
CREATE INDEX "PracticeRecord_learnerId_idx" ON "PracticeRecord"("learnerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
