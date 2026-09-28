-- 计费口径拆分：BYOK（用户自有渠道）调用不扣余额，但仍会算出折算金额。
-- 为了在日志/统计里区分「实际扣的钱」与「折算金额」，新增两列并回填历史数据。

-- 1) RequestLog.chargeable：该次调用是否实际计费（平台渠道 = true，BYOK = false）
ALTER TABLE "RequestLog" ADD COLUMN "chargeable" BOOLEAN NOT NULL DEFAULT true;

-- 按渠道归属回填历史行；渠道已被删除的行保持默认 true（这些行 cost=0，不影响金额）
UPDATE "RequestLog" rl
SET chargeable = (c."ownerType" = 'PLATFORM')
FROM "Channel" c
WHERE rl."channelId" = c.id;

-- 2) UsageDaily.billedCost：按日「实际扣费」金额；cost 保持为折算总额
ALTER TABLE "UsageDaily" ADD COLUMN "billedCost" DECIMAL(18,6) NOT NULL DEFAULT 0;

UPDATE "UsageDaily" ud
SET "billedCost" = COALESCE(s.billed, 0)
FROM (
  SELECT
    "userId",
    "apiKeyId",
    date_trunc('day', "createdAt")::date AS d,
    SUM(cost) AS billed
  FROM "RequestLog"
  WHERE chargeable = true
  GROUP BY 1, 2, 3
) s
WHERE ud."userId" = s."userId"
  AND ud."apiKeyId" IS NOT DISTINCT FROM s."apiKeyId"
  AND ud."date" = s.d;

-- 3) ApiKey.costUsed 语义改为「实际扣费」（费用额度只被真实花费消耗），
--    按明细回填，口径与 usage.service 的逐次累加一致。
UPDATE "ApiKey" k
SET "costUsed" = COALESCE(s.billed, 0)
FROM (
  SELECT "apiKeyId", SUM(cost) AS billed
  FROM "RequestLog"
  WHERE chargeable = true
  GROUP BY 1
) s
WHERE k."id" = s."apiKeyId";
