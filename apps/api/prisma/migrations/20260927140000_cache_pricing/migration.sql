-- 缓存读/写价格（官方价）
ALTER TABLE "ModelCatalog" ADD COLUMN "cacheReadPrice" DECIMAL(18,6) NOT NULL DEFAULT 0;
ALTER TABLE "ModelCatalog" ADD COLUMN "cacheWritePrice" DECIMAL(18,6) NOT NULL DEFAULT 0;

-- 调用明细记录缓存读写 token
ALTER TABLE "RequestLog" ADD COLUMN "cacheReadTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RequestLog" ADD COLUMN "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0;
