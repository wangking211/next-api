-- 模型能力标签与别名（OpenRouter 对标：capability 元数据 + latest 别名）
ALTER TABLE "ModelCatalog" ADD COLUMN "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ModelCatalog" ADD COLUMN "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[];
