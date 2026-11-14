-- 请求日志：视频任务的上游计费 token（video-tokens）
-- 独立列而不并入 totalTokens：视频 token 与对话 token 不同量纲，
-- 混入会污染 TPM 限额、日聚合图表与按 token 计价的口径。
ALTER TABLE "RequestLog" ADD COLUMN "videoTokens" INTEGER;
