-- DropIndex
DROP INDEX "GradingStudent_classId_name_key";

-- AlterTable
ALTER TABLE "GradingStudent" ADD COLUMN "studentNo" TEXT;

-- AlterTable
ALTER TABLE "GradingSubmission" ADD COLUMN "detectedClass" TEXT;
ALTER TABLE "GradingSubmission" ADD COLUMN "detectedStudentNo" TEXT;
ALTER TABLE "GradingSubmission" ADD COLUMN "matchCandidates" TEXT;
ALTER TABLE "GradingSubmission" ADD COLUMN "matchConfidence" REAL;
ALTER TABLE "GradingSubmission" ADD COLUMN "matchReason" TEXT;
ALTER TABLE "GradingSubmission" ADD COLUMN "matchStatus" TEXT;

-- AlterTable
ALTER TABLE "GradingTask" ADD COLUMN "extraClassIds" TEXT;

-- CreateIndex
CREATE INDEX "GradingStudent_classId_name_idx" ON "GradingStudent"("classId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "GradingStudent_classId_studentNo_key" ON "GradingStudent"("classId", "studentNo");

-- 已有答卷：已指定学生的视为老师确认过的匹配，避免升级后被误标为待确认
UPDATE "GradingSubmission" SET "matchStatus" = 'manual' WHERE "studentId" IS NOT NULL;
