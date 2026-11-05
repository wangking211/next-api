-- 计价币种统一：官方标价可按 CNY/USD 录入（官方原币价快照 + 录入时汇率），记账本位恒为 USD
DO $$ BEGIN
  CREATE TYPE "PriceCurrency" AS ENUM ('CNY', 'USD');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "ModelCatalog" ADD COLUMN IF NOT EXISTS "priceCurrency" "PriceCurrency" NOT NULL DEFAULT 'USD';
ALTER TABLE "ModelCatalog" ADD COLUMN IF NOT EXISTS "fxRate" DECIMAL(18,6);
ALTER TABLE "ModelCatalog" ADD COLUMN IF NOT EXISTS "officialPrices" JSONB;

-- 对账人民币列的按日汇率快照（北京时间自然日；缺日回退查询时实时汇率）
CREATE TABLE IF NOT EXISTS "DailyFxRate" (
  "day"        TEXT NOT NULL,
  "cnyPerUsd"  DECIMAL(18,6) NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DailyFxRate_pkey" PRIMARY KEY ("day")
);
