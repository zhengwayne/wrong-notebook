-- 可逆：删除识别题目并去掉试卷上的识别字段，不影响卷面图片、错题本和孩子档案。

DROP INDEX IF EXISTS "ParentPaperQuestion_paperId_position_idx";
DROP TABLE IF EXISTS "ParentPaperQuestion";

DROP INDEX IF EXISTS "ParentPaper_userId_status_idx";
ALTER TABLE "ParentPaper" DROP COLUMN "confirmedAt";
ALTER TABLE "ParentPaper" DROP COLUMN "recognizedAt";
ALTER TABLE "ParentPaper" DROP COLUMN "errorMessage";
ALTER TABLE "ParentPaper" DROP COLUMN "hasAnswerKey";
ALTER TABLE "ParentPaper" DROP COLUMN "answerKeyImages";
