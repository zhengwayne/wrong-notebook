-- CreateTable
CREATE TABLE "WechatBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appId" TEXT NOT NULL,
    "openid" TEXT NOT NULL,
    "unionid" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" DATETIME,
    CONSTRAINT "WechatBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MiniProgramSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "openid" TEXT NOT NULL,
    "authVersion" INTEGER NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MiniProgramSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "WechatBinding_userId_idx" ON "WechatBinding"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WechatBinding_appId_openid_key" ON "WechatBinding"("appId", "openid");

-- CreateIndex
CREATE UNIQUE INDEX "WechatBinding_appId_userId_key" ON "WechatBinding"("appId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "MiniProgramSession_tokenHash_key" ON "MiniProgramSession"("tokenHash");

-- CreateIndex
CREATE INDEX "MiniProgramSession_userId_idx" ON "MiniProgramSession"("userId");

-- CreateIndex
CREATE INDEX "MiniProgramSession_appId_openid_idx" ON "MiniProgramSession"("appId", "openid");

-- CreateIndex
CREATE INDEX "MiniProgramSession_expiresAt_idx" ON "MiniProgramSession"("expiresAt");

