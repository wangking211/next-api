-- 用户/代理：售价折扣率改为“相对渠道价的倍率”
-- 用户价 = 渠道价 × priceMultiplier（1 = 与渠道价相同，>1 加价）
ALTER TABLE "User" RENAME COLUMN "discount" TO "priceMultiplier";
