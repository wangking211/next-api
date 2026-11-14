-- 制成品（视频/图片）：网关侧留存的上游生成物
CREATE TYPE "AssetKind" AS ENUM ('VIDEO', 'IMAGE');
CREATE TYPE "AssetStatus" AS ENUM ('PENDING', 'CAPTURING', 'READY', 'FAILED');

CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "channelId" TEXT,
    "requestLogId" TEXT,
    "kind" "AssetKind" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'PENDING',
    "model" TEXT NOT NULL,
    "sourceTaskId" TEXT,
    "sourceUrl" TEXT,
    "storageKey" TEXT,
    "bytes" INTEGER,
    "contentType" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" INTEGER,
    "meta" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- 同一上游任务只登记一条成品（重试/重复轮询不会产生重复行）
CREATE UNIQUE INDEX "MediaAsset_sourceTaskId_key" ON "MediaAsset"("sourceTaskId");
CREATE INDEX "MediaAsset_userId_createdAt_idx" ON "MediaAsset"("userId", "createdAt");
CREATE INDEX "MediaAsset_status_createdAt_idx" ON "MediaAsset"("status", "createdAt");
CREATE INDEX "MediaAsset_kind_createdAt_idx" ON "MediaAsset"("kind", "createdAt");
CREATE INDEX "MediaAsset_channelId_idx" ON "MediaAsset"("channelId");

ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
