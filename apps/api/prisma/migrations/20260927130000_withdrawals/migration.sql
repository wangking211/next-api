-- 提现申请：申请时冻结（扣减）余额，管理员审批（通过/驳回退回）
ALTER TYPE "BalanceTxType" ADD VALUE IF NOT EXISTS 'WITHDRAW';

DO $$ BEGIN
  CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "WithdrawalRequest" (
  "id"           TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  "amount"       DECIMAL(18,6) NOT NULL,
  "status"       "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
  "note"         TEXT,
  "reviewedById" TEXT,
  "reviewedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WithdrawalRequest_userId_createdAt_idx"
  ON "WithdrawalRequest"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "WithdrawalRequest_status_createdAt_idx"
  ON "WithdrawalRequest"("status", "createdAt");

ALTER TABLE "WithdrawalRequest"
  ADD CONSTRAINT "WithdrawalRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
