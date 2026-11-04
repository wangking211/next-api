-- 请求日志：上游请求 id（逐笔对账用）
ALTER TABLE "RequestLog" ADD COLUMN "upstreamRequestId" TEXT;
CREATE INDEX "RequestLog_upstreamRequestId_idx" ON "RequestLog"("upstreamRequestId");
