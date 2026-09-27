#!/usr/bin/env bash
#
# 每日数据库备份：对运行中的 ai-gateway-postgres 容器执行 pg_dump 并 gzip。
# 用法：  /opt/AiProject/ops/pg-backup.sh
# 还原：  gunzip -c <file>.sql.gz | docker exec -i ai-gateway-postgres psql -U aigw -d ai_gateway
#
# 环境变量（均有默认值）：
#   BACKUP_DIR     备份目录           默认 /var/backups/aigw
#   RETENTION_DAYS 保留天数           默认 14
#   PG_CONTAINER   Postgres 容器名     默认 ai-gateway-postgres
#   DB_USER / DB_NAME                 默认 aigw / ai_gateway
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/aigw}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PG_CONTAINER="${PG_CONTAINER:-ai-gateway-postgres}"
DB_USER="${DB_USER:-aigw}"
DB_NAME="${DB_NAME:-ai_gateway}"

mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/${DB_NAME}-$(date +%Y%m%d-%H%M%S).sql.gz"

docker exec "$PG_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
  --no-owner --no-privileges | gzip > "$out"

# 校验 gzip 完整性，损坏则删除并以非零退出（触发告警）
if ! gzip -t "$out" 2>/dev/null; then
  rm -f "$out"
  echo "backup FAILED: gzip integrity check" >&2
  exit 1
fi

# 清理过期备份
find "$BACKUP_DIR" -type f -name '*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "$(date -u +%FT%TZ) backup ok: $out ($(du -h "$out" | cut -f1))"
