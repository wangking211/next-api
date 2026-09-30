-- 热路径索引（幂等写法：CREATE/DROP ... IF (NOT) EXISTS）
-- User_agentId_idx 已由 20260927090000_agent_and_user_discount 创建（手写迁移未回写 schema），
-- 生产库也可能存在手工加过的索引 → 统一用 IF NOT EXISTS/IF EXISTS，重放与升级都不会撞名。

-- DropIndex：ApiKey_userId_createdAt_idx 的前缀已覆盖 userId-only 查询，删掉单列索引
DROP INDEX IF EXISTS "ApiKey_userId_idx";

-- CreateIndex：代理/分销维度（overview/members 的关系过滤走这里）
CREATE INDEX IF NOT EXISTS "User_agentId_idx" ON "User"("agentId");

-- CreateIndex：分组维度
CREATE INDEX IF NOT EXISTS "User_groupId_idx" ON "User"("groupId");

-- CreateIndex：管理端按创建时间倒序分页
CREATE INDEX IF NOT EXISTS "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex：令牌列表按创建时间倒序
CREATE INDEX IF NOT EXISTS "ApiKey_userId_createdAt_idx" ON "ApiKey"("userId", "createdAt");

-- CreateIndex：管理端按日期维度聚合（不带 userId 过滤）
CREATE INDEX IF NOT EXISTS "UsageDaily_date_idx" ON "UsageDaily"("date");
