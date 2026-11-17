-- 统一异步作业、幂等键与断线恢复存储表
CREATE TABLE "AsyncOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "statusCode" INTEGER,
    "subject" TEXT,
    "link" TEXT,
    "progressJson" TEXT,
    "responseJson" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "expiresAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AsyncOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AsyncOperation_scopeKey_category_kind_idempotencyKey_key" ON "AsyncOperation"("scopeKey", "category", "kind", "idempotencyKey");
CREATE INDEX "AsyncOperation_userId_category_status_startedAt_idx" ON "AsyncOperation"("userId", "category", "status", "startedAt");
CREATE INDEX "AsyncOperation_expiresAt_idx" ON "AsyncOperation"("expiresAt");

-- 用户按日 AI 调用配额原子计数表
CREATE TABLE "AiDailyQuota" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiDailyQuota_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AiDailyQuota_userId_dayKey_key" ON "AiDailyQuota"("userId", "dayKey");
CREATE INDEX "AiDailyQuota_dayKey_idx" ON "AiDailyQuota"("dayKey");
