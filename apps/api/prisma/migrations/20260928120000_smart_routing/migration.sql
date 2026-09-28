-- 智能路由：路由策略枚举（ApiKey 级）+ 渠道×模型人工质量分（L1）+ 渠道每日限额
CREATE TYPE "RoutingStrategy" AS ENUM ('BALANCED', 'CHEAPEST', 'FASTEST', 'STABLE', 'QUALITY_FIRST');

ALTER TABLE "ApiKey" ADD COLUMN "routingStrategy" "RoutingStrategy";

-- qualityScore：1 = 正常，越低越可疑（疑似降智/蒸馏版）
ALTER TABLE "ChannelModel" ADD COLUMN "qualityScore" DECIMAL(4,2) NOT NULL DEFAULT 1;

-- 每日限额：null/0 = 不限，超限后由智能路由排除该渠道（Redis 按自然日计数）
ALTER TABLE "Channel" ADD COLUMN "dailyRequestLimit" INTEGER;
ALTER TABLE "Channel" ADD COLUMN "dailyTokenLimit" INTEGER;
