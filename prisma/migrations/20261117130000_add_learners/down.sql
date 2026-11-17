-- 可逆：先撤回回填数据（scripts/backfill-learners.ts --revert），再执行本文件即可去掉表和列。
-- SQLite 3.35+ 支持 DROP COLUMN；不删除任何错题或练习记录行。

DROP INDEX IF EXISTS "PracticeRecord_learnerId_idx";
DROP INDEX IF EXISTS "ErrorItem_learnerId_idx";
DROP INDEX IF EXISTS "LearnerBackfillAudit_entityType_entityId_idx";
DROP INDEX IF EXISTS "LearnerBackfillAudit_batchId_idx";
DROP INDEX IF EXISTS "Learner_userId_kind_idx";
DROP INDEX IF EXISTS "Learner_gradingStudentId_key";

ALTER TABLE "PracticeRecord" DROP COLUMN "learnerId";
ALTER TABLE "ErrorItem" DROP COLUMN "learnerId";

DROP TABLE IF EXISTS "LearnerBackfillAudit";
DROP TABLE IF EXISTS "Learner";
