-- 渠道×模型：拆分上游成本折扣与下游售价折扣
ALTER TABLE "ChannelModel" ADD COLUMN "costDiscount" DECIMAL(6,4);
ALTER TABLE "ChannelModel" ADD COLUMN "priceDiscount" DECIMAL(6,4);

-- 兼容旧 discount：视为下游售价折扣
UPDATE "ChannelModel"
SET "priceDiscount" = "discount"
WHERE "discount" IS NOT NULL AND "priceDiscount" IS NULL;
