-- AlterTable
ALTER TABLE "User" ADD COLUMN "personas" TEXT NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "activePersona" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "personasConfirmedAt" DATETIME;
