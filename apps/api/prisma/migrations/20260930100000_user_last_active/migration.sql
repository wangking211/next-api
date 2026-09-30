-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastActiveAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_lastActiveAt_idx" ON "User"("lastActiveAt");


-- Backfill: 用历史调用明细物化「最后活跃」，部署后立即可排序
UPDATE "User" u SET "lastActiveAt" = sub."last"
FROM (SELECT "userId", MAX("createdAt") AS "last" FROM "RequestLog" WHERE "userId" IS NOT NULL GROUP BY "userId") sub
WHERE u."id" = sub."userId";
