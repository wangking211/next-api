-- 模型目录：低谷价倍率（0~1，低谷期成本/售价统一乘该系数；null/1 = 无峰谷差异）
ALTER TABLE "ModelCatalog" ADD COLUMN "offPeakMultiplier" DECIMAL(6, 4);
