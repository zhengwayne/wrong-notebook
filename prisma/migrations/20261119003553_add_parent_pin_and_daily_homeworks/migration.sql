-- CreateTable
CREATE TABLE "DailyHomeworkItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL DEFAULT 'math',
    "category" TEXT NOT NULL DEFAULT 'written',
    "title" TEXT NOT NULL,
    "estimatedMinutes" INTEGER,
    "actualMinutes" INTEGER,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" DATETIME,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DailyHomeworkItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DailyHomeworkItem_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "Learner" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "educationStage" TEXT,
    "enrollmentYear" INTEGER,
    "gradeRecognitionMode" TEXT NOT NULL DEFAULT 'fixed',
    "fixedGradeSemester" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "authVersion" INTEGER NOT NULL DEFAULT 0,
    "personas" TEXT NOT NULL DEFAULT '[]',
    "activePersona" TEXT,
    "personasConfirmedAt" DATETIME,
    "confirmBeforeImport" BOOLEAN NOT NULL DEFAULT false,
    "questionDuplicateThreshold" REAL NOT NULL DEFAULT 90,
    "masteryThreshold" INTEGER NOT NULL DEFAULT 50,
    "variantPipelineEnabled" BOOLEAN NOT NULL DEFAULT true,
    "enableGeogebra" BOOLEAN NOT NULL DEFAULT false,
    "enableSvgAnimation" BOOLEAN NOT NULL DEFAULT true,
    "themePreference" TEXT NOT NULL DEFAULT 'system',
    "reviewAlgorithmVersion" TEXT NOT NULL DEFAULT 'ebbinghaus-v1',
    "parentPinHash" TEXT,
    "parentPinFailedCount" INTEGER NOT NULL DEFAULT 0,
    "parentPinLockedUntil" DATETIME
);
INSERT INTO "new_User" ("activePersona", "authVersion", "confirmBeforeImport", "createdAt", "educationStage", "email", "enableGeogebra", "enableSvgAnimation", "enrollmentYear", "fixedGradeSemester", "gradeRecognitionMode", "id", "isActive", "masteryThreshold", "name", "password", "personas", "personasConfirmedAt", "questionDuplicateThreshold", "reviewAlgorithmVersion", "role", "themePreference", "updatedAt", "variantPipelineEnabled") SELECT "activePersona", "authVersion", "confirmBeforeImport", "createdAt", "educationStage", "email", "enableGeogebra", "enableSvgAnimation", "enrollmentYear", "fixedGradeSemester", "gradeRecognitionMode", "id", "isActive", "masteryThreshold", "name", "password", "personas", "personasConfirmedAt", "questionDuplicateThreshold", "reviewAlgorithmVersion", "role", "themePreference", "updatedAt", "variantPipelineEnabled" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "DailyHomeworkItem_userId_learnerId_dateKey_idx" ON "DailyHomeworkItem"("userId", "learnerId", "dateKey");
