-- 为家长试卷与教师答卷引入乐观锁版本号
ALTER TABLE "ParentPaper" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GradingSubmission" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- 创建来源题导入去重表
CREATE TABLE "SourceImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceQuestionId" TEXT NOT NULL,
    "errorItemId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SourceImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SourceImport_userId_sourceKind_sourceQuestionId_key" ON "SourceImport"("userId", "sourceKind", "sourceQuestionId");
CREATE INDEX "SourceImport_userId_sourceKind_sourceId_idx" ON "SourceImport"("userId", "sourceKind", "sourceId");
CREATE INDEX "SourceImport_errorItemId_idx" ON "SourceImport"("errorItemId");
