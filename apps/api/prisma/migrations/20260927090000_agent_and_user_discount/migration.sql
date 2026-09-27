-- 代理/分销商：Role 增加 AGENT；用户增加额外折扣与归属代理
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'AGENT';

ALTER TABLE "User" ADD COLUMN "discount" DECIMAL(6,4);
ALTER TABLE "User" ADD COLUMN "agentId" TEXT;

CREATE INDEX "User_agentId_idx" ON "User"("agentId");

ALTER TABLE "User"
  ADD CONSTRAINT "User_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
