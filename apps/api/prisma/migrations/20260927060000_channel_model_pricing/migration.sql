-- 渠道 × 模型 定价表：同一模型可由多个上游提供，成本/售价/折扣各异
CREATE TABLE "ChannelModel" (
  "id"          TEXT NOT NULL,
  "channelId"   TEXT NOT NULL,
  "modelName"   TEXT NOT NULL,
  "costInput"   DECIMAL(18,6),
  "costOutput"  DECIMAL(18,6),
  "priceInput"  DECIMAL(18,6),
  "priceOutput" DECIMAL(18,6),
  "discount"    DECIMAL(6,4),
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "priority"    INTEGER,
  "weight"      INTEGER,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChannelModel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelModel_channelId_modelName_key"
  ON "ChannelModel"("channelId", "modelName");

CREATE INDEX "ChannelModel_modelName_enabled_idx"
  ON "ChannelModel"("modelName", "enabled");

ALTER TABLE "ChannelModel"
  ADD CONSTRAINT "ChannelModel_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "Channel"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- RequestLog 记录上游成本，便于毛利统计
ALTER TABLE "RequestLog"
  ADD COLUMN "upstreamCost" DECIMAL(18,6) NOT NULL DEFAULT 0;

-- 回填：将每个渠道现有 models[] 展开为 ChannelModel，售价默认取模型目录价
INSERT INTO "ChannelModel"
  ("id","channelId","modelName","priceInput","priceOutput","enabled","createdAt","updatedAt")
SELECT
  gen_random_uuid()::text, c."id", m.name, mc."inputPrice", mc."outputPrice", true, now(), now()
FROM "Channel" c
CROSS JOIN LATERAL unnest(c."models") AS m(name)
LEFT JOIN "ModelCatalog" mc ON mc."name" = m.name
ON CONFLICT ("channelId","modelName") DO NOTHING;
