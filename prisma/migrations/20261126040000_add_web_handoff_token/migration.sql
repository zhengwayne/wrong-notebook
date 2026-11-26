-- CreateTable
CREATE TABLE "WebHandoffToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mpSessionId" TEXT NOT NULL,
    "nextPath" TEXT NOT NULL,
    "authVersion" INTEGER NOT NULL,
    "kidLock" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebHandoffToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "WebHandoffToken_tokenHash_key" ON "WebHandoffToken"("tokenHash");

-- CreateIndex
CREATE INDEX "WebHandoffToken_userId_idx" ON "WebHandoffToken"("userId");

-- CreateIndex
CREATE INDEX "WebHandoffToken_expiresAt_idx" ON "WebHandoffToken"("expiresAt");
