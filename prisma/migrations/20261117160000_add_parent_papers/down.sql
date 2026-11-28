-- 可逆：删除家长试卷及其页，不影响错题、练习记录或孩子档案。

DROP INDEX IF EXISTS "ParentPaperPage_paperId_position_idx";
DROP INDEX IF EXISTS "ParentPaper_userId_learnerId_createdAt_idx";
DROP TABLE IF EXISTS "ParentPaperPage";
DROP TABLE IF EXISTS "ParentPaper";
