-- API Key 删除后 UsageDaily.apiKeyId 被置为 NULL（onDelete: SetNull），
-- 既会让唯一约束 [userId, apiKeyId, date] 对 NULL 失效，也会让同一 (userId,date) 堆积多行。
-- 1) 合并已存在的重复 NULL 行；2) 建立仅覆盖 NULL 的分部唯一索引。

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY "userId", date ORDER BY id) AS rn,
    sum(requests) OVER (PARTITION BY "userId", date) AS s_req,
    sum("promptTokens") OVER (PARTITION BY "userId", date) AS s_prompt,
    sum("completionTokens") OVER (PARTITION BY "userId", date) AS s_completion,
    sum("totalTokens") OVER (PARTITION BY "userId", date) AS s_total,
    sum(cost) OVER (PARTITION BY "userId", date) AS s_cost
  FROM "UsageDaily"
  WHERE "apiKeyId" IS NULL
)
UPDATE "UsageDaily" u
SET
  requests = r.s_req,
  "promptTokens" = r.s_prompt,
  "completionTokens" = r.s_completion,
  "totalTokens" = r.s_total,
  cost = r.s_cost
FROM ranked r
WHERE u.id = r.id AND r.rn = 1;

DELETE FROM "UsageDaily" u
USING (
  SELECT id, row_number() OVER (PARTITION BY "userId", date ORDER BY id) AS rn
  FROM "UsageDaily"
  WHERE "apiKeyId" IS NULL
) d
WHERE u.id = d.id AND d.rn > 1;

CREATE UNIQUE INDEX "UsageDaily_user_nullkey_date_key"
  ON "UsageDaily" ("userId", date)
  WHERE "apiKeyId" IS NULL;
