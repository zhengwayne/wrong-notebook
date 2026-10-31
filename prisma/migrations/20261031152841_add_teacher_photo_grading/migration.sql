-- CreateTable
CREATE TABLE "GradingClass" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GradingClass_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GradingStudent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GradingStudent_classId_fkey" FOREIGN KEY ("classId") REFERENCES "GradingClass" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GradingTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL DEFAULT '数学',
    "examPaperId" TEXT,
    "keyImageUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GradingTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GradingTask_classId_fkey" FOREIGN KEY ("classId") REFERENCES "GradingClass" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GradingKeyQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'objective',
    "maxScore" REAL NOT NULL DEFAULT 1,
    "answer" TEXT NOT NULL DEFAULT '',
    "acceptedAnswers" TEXT,
    "questionText" TEXT,
    "knowledgePoints" TEXT,
    CONSTRAINT "GradingKeyQuestion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "GradingTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GradingSubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "studentId" TEXT,
    "detectedName" TEXT,
    "images" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalScore" REAL,
    "error" TEXT,
    "confirmedAt" DATETIME,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GradingSubmission_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "GradingTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GradingSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "GradingStudent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GradingResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "keyQuestionId" TEXT NOT NULL,
    "studentAnswer" TEXT,
    "verdict" TEXT NOT NULL,
    "score" REAL NOT NULL DEFAULT 0,
    "aiScore" REAL,
    "reason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'auto',
    "errorItemId" TEXT,
    CONSTRAINT "GradingResult_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "GradingSubmission" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GradingResult_keyQuestionId_fkey" FOREIGN KEY ("keyQuestionId") REFERENCES "GradingKeyQuestion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "GradingClass_userId_name_key" ON "GradingClass"("userId", "name");

-- CreateIndex
CREATE INDEX "GradingStudent_classId_order_idx" ON "GradingStudent"("classId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "GradingStudent_classId_name_key" ON "GradingStudent"("classId", "name");

-- CreateIndex
CREATE INDEX "GradingTask_userId_createdAt_idx" ON "GradingTask"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GradingTask_classId_idx" ON "GradingTask"("classId");

-- CreateIndex
CREATE INDEX "GradingKeyQuestion_taskId_order_idx" ON "GradingKeyQuestion"("taskId", "order");

-- CreateIndex
CREATE INDEX "GradingSubmission_taskId_createdAt_idx" ON "GradingSubmission"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "GradingSubmission_studentId_idx" ON "GradingSubmission"("studentId");

-- CreateIndex
CREATE INDEX "GradingResult_keyQuestionId_idx" ON "GradingResult"("keyQuestionId");

-- CreateIndex
CREATE UNIQUE INDEX "GradingResult_submissionId_keyQuestionId_key" ON "GradingResult"("submissionId", "keyQuestionId");
