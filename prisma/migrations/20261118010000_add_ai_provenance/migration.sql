-- CreateTable
CREATE TABLE "AiProvenance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AiProvenance_task_provider_model_promptVersion_parserVersion_key" ON "AiProvenance"("task", "provider", "model", "promptVersion", "parserVersion");

-- AlterTable
ALTER TABLE "ErrorItem" ADD COLUMN "provenanceId" TEXT;

-- AlterTable
ALTER TABLE "GradingResult" ADD COLUMN "provenanceId" TEXT;

-- AlterTable
ALTER TABLE "VariantItem" ADD COLUMN "provenanceId" TEXT;

-- AlterTable
ALTER TABLE "ParentPaperQuestion" ADD COLUMN "provenanceId" TEXT;
