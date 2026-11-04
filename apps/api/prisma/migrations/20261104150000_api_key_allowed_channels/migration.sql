-- Key 级渠道白名单：空数组 = 不限制（按分组/共享可见性路由），仅收窄候选集
ALTER TABLE "ApiKey" ADD COLUMN "allowedChannelIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
