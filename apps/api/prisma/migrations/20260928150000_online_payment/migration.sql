-- 在线充值订单（微信/支付宝，经 JAIPay 网关）：回调验签后幂等入账
DO $$ BEGIN
  CREATE TYPE "PaymentOrderStatus" AS ENUM ('PENDING', 'PAID', 'CLOSED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "PaymentOrder" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "mchOrderNo"     TEXT NOT NULL,
  "payOrderId"     TEXT,
  "wayCode"        TEXT NOT NULL,
  "channel"        TEXT,
  "channelOrderNo" TEXT,
  "amountCents"    INTEGER NOT NULL,
  "creditUsd"      DECIMAL(18,6) NOT NULL,
  "credits"        DECIMAL(18,2) NOT NULL,
  "status"         "PaymentOrderStatus" NOT NULL DEFAULT 'PENDING',
  "paidAt"         TIMESTAMP(3),
  "notifyRaw"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentOrder_mchOrderNo_key"
  ON "PaymentOrder"("mchOrderNo");

CREATE INDEX IF NOT EXISTS "PaymentOrder_userId_createdAt_idx"
  ON "PaymentOrder"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "PaymentOrder_status_createdAt_idx"
  ON "PaymentOrder"("status", "createdAt");

ALTER TABLE "PaymentOrder"
  ADD CONSTRAINT "PaymentOrder_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
