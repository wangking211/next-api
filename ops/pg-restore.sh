#!/usr/bin/env bash
#
# 数据库恢复：把 pg-backup.sh 产出的 .sql.gz 原子地恢复进目标库。
#
# 为什么不能用旧的「gunzip | psql」裸灌（README 已废弃该写法）：
#   pg_dump 纯格式只有 CREATE、没有 DROP —— 灌进已有表结构的库会从第一张表
#   开始逐条报 relation ... already exists，而 psql 默认遇错继续，最终得到一个
#   「部分成功、无法判断」的库；真出事时要恢复的恰恰是这种「已有结构」的库。
# 本脚本的做法：
#   1. 先 gzip -t 校验备份完整性，没过就绝不碰目标库；
#   2. 把 DROP SCHEMA / CREATE SCHEMA 拼在 dump 语句流最前面；
#   3. psql --single-transaction -v ON_ERROR_STOP=1：任一步失败连同 DROP 一起
#      回滚，目标库保持原样；全部成功才整体提交。
#
# 用法：
#   ops/pg-restore.sh <dump.sql.gz> [目标库] --yes
#
# 恢复生产库（恢复期间必须停 API）：
#   docker compose stop api
#   ops/pg-restore.sh /var/backups/aigw/ai_gateway-<ts>.sql.gz ai_gateway --yes
#   docker compose up -d api
#
# 日常演练用 ops/pg-restore-drill.sh，它只操作临时库，不碰生产数据。
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-ai-gateway-postgres}"
DB_USER="${DB_USER:-aigw}"
DB_NAME="${DB_NAME:-ai_gateway}"

dump="${1:-}"
target="${2:-$DB_NAME}"
flag="${3:-}"

if [ -z "$dump" ]; then
  echo "usage: pg-restore.sh <dump.sql.gz> [target-db] --yes" >&2
  exit 2
fi
if [ "$flag" != "--yes" ]; then
  echo "refusing to restore without explicit --yes (target=$target dump=$dump)" >&2
  exit 2
fi
if [ ! -f "$dump" ]; then
  echo "dump not found: $dump" >&2
  exit 1
fi

# 先验完整性，再做任何破坏性动作
if ! gzip -t "$dump" 2>/dev/null; then
  echo "dump failed gzip integrity check: $dump" >&2
  exit 1
fi

echo "$(date -u +%FT%TZ) restore start: $dump -> $target"

{
  printf 'DROP SCHEMA public CASCADE;\n'
  printf 'CREATE SCHEMA public;\n'
  gunzip -c "$dump"
} | docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$target" \
  -v ON_ERROR_STOP=1 --single-transaction -q

echo "$(date -u +%FT%TZ) restore ok: $target"
