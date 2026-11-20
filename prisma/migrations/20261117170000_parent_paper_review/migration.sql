-- AlterTable
ALTER TABLE "ParentPaper" ADD COLUMN "answerKeyImages" TEXT;
ALTER TABLE "ParentPaper" ADD COLUMN "hasAnswerKey" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "ParentPaper" ADD COLUMN "errorMessage" TEXT;
ALTER TABLE "ParentPaper" ADD COLUMN "recognizedAt" DATETIME;
ALTER TABLE "ParentPaper" ADD COLUMN "confirmedAt" DATETIME;

-- CreateIndex
CREATE INDEX "ParentPaper_userId_status_idx" ON "ParentPaper"("userId", "status");

-- CreateTable
CREATE TABLE "ParentPaperQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'objective',
    "questionText" TEXT NOT NULL DEFAULT '',
    "studentAnswer" TEXT NOT NULL DEFAULT '',
    "correctAnswer" TEXT NOT NULL DEFAULT '',
    "verdict" TEXT NOT NULL,
    "overrideVerdict" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0,
    "errorCause" TEXT,
    "knowledgePoints" TEXT NOT NULL DEFAULT '[]',
    "bbox" TEXT,
    "subjectHint" TEXT,
    "importedErrorItemId" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ParentPaperQuestion_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "ParentPaper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ParentPaperQuestion_paperId_position_idx" ON "ParentPaperQuestion"("paperId", "position");
