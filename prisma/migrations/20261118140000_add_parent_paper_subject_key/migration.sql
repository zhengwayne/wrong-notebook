-- 家长试卷增加可选学科字段，用于识卷提示、核验跳过与入库到对应错题本
ALTER TABLE "ParentPaper" ADD COLUMN "subjectKey" TEXT;
