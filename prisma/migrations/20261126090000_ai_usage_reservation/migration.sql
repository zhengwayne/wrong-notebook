-- AI 次数改为「预留 → 成功确认 / 失败退回」：既有记录视为已确认
ALTER TABLE "AiUsage" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'confirmed';
ALTER TABLE "AiUsage" ADD COLUMN "dayKey" TEXT;
ALTER TABLE "AiUsage" ADD COLUMN "requestKey" TEXT;
ALTER TABLE "AiUsage" ADD COLUMN "ref" TEXT;
ALTER TABLE "AiUsage" ADD COLUMN "settledAt" DATETIME;

CREATE UNIQUE INDEX "AiUsage_userId_requestKey_key" ON "AiUsage"("userId", "requestKey");
CREATE INDEX "AiUsage_status_createdAt_idx" ON "AiUsage"("status", "createdAt");
CREATE INDEX "AiUsage_ref_idx" ON "AiUsage"("ref");
