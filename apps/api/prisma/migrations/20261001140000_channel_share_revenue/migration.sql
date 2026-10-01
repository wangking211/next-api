-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "shareRevenue" DECIMAL(18,6) NOT NULL DEFAULT 0;

-- Backfill: 用已有的 RequestLog.channelRevenue 回填历史收益。
-- （新行由 UsageService.record 在热路径同事务累加，与 shareUsed* 同一维护点）
UPDATE "Channel" c
SET "shareRevenue" = COALESCE(
    (SELECT SUM(rl."channelRevenue") FROM "RequestLog" rl WHERE rl."channelId" = c.id),
    0
);

