-- 可逆：只去掉身份字段，不删除用户或错题
ALTER TABLE "User" DROP COLUMN "personasConfirmedAt";
ALTER TABLE "User" DROP COLUMN "activePersona";
ALTER TABLE "User" DROP COLUMN "personas";
