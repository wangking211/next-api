-- 代理返点：代理用户返点比例；用户消耗时按比例给各级代理入账
ALTER TYPE "BalanceTxType" ADD VALUE IF NOT EXISTS 'COMMISSION';

ALTER TABLE "User" ADD COLUMN "rebateRate" DECIMAL(6,4);

ALTER TABLE "RequestLog" ADD COLUMN "commission" DECIMAL(18,6) NOT NULL DEFAULT 0;
