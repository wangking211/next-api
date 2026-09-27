-- 性能索引：渠道按模型查询、调用日志常用过滤/排序、按天聚合按 key 查询
CREATE INDEX IF NOT EXISTS "Channel_models_gin_idx"
  ON "Channel" USING gin ("models");

CREATE INDEX IF NOT EXISTS "RequestLog_createdAt_idx"
  ON "RequestLog" ("createdAt" DESC);

CREATE INDEX IF NOT EXISTS "RequestLog_channelId_createdAt_idx"
  ON "RequestLog" ("channelId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "RequestLog_status_createdAt_idx"
  ON "RequestLog" ("status", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "UsageDaily_apiKeyId_date_idx"
  ON "UsageDaily" ("apiKeyId", "date");
