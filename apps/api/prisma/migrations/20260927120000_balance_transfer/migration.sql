-- 代理给成员充值（代理余额转出、成员余额转入）用 TRANSFER 流水分录
ALTER TYPE "BalanceTxType" ADD VALUE IF NOT EXISTS 'TRANSFER';
