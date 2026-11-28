-- 可逆：去掉页图上保留的原始照片字段，不影响当前展示用的 imageUrl。
ALTER TABLE "ParentPaperPage" DROP COLUMN "originalImageUrl";
