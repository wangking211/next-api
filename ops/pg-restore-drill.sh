#!/usr/bin/env bash
#
# 恢复演练：验证「真出事时」那条恢复路径 —— 把备份【覆盖恢复进一个已有结构
# 和数据的库】。历史上的手工演练是灌进全新空库，恰好绕开了 already exists 的
# 坑（旧写法在覆盖场景会失败，见 pg-restore.sh 头注释）。
#
# 流程：
#   1. 取最新备份（或 $1 指定），没有即退出；
#   2. 建临时库 ai_gateway_drill，先灌一遍备份 —— 模拟「库里已有结构+数据」；
#   3. TRUNCATE 核心表制造脏库 —— 之后行数对不上就证明覆盖恢复没生效，
#      防止「全程报错却静默跳过」的假绿；
#   4. 调 pg-restore.sh 覆盖恢复 —— 关键路径，ON_ERROR_STOP 任一错误即失败；
#   5. 逐表行数与覆盖前快照比对，必须完全一致；
#   6. 删除临时库（trap 兜底）；结果追加到 ops/DRILL.log；失败 → 非零退出。
#
# 用法：ops/pg-restore-drill.sh [备份文件.sql.gz]   （默认取 BACKUP_DIR 最新一份）
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/aigw}"
PG_CONTAINER="${PG_CONTAINER:-ai-gateway-postgres}"
DB_USER="${DB_USER:-aigw}"
DRILL_DB="${DRILL_DB:-ai_gateway_drill}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DRILL_LOG="${DRILL_LOG:-$SCRIPT_DIR/DRILL.log}"

psql_admin() {
  docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -Atq "$@"
}
psql_db() {
  docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$1" -v ON_ERROR_STOP=1 -Atq "${@:2}"
}

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$DRILL_LOG"; }

cleanup() {
  psql_admin -c "DROP DATABASE IF EXISTS ${DRILL_DB} WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# public 下所有用户表的行数快照，形如："ApiKey"=12 "User"=3
counts_of() {
  local db="$1" out="" t n
  for t in $(psql_db "$db" -c \
    "SELECT format('%I', tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename"); do
    n=$(psql_db "$db" -c "SELECT count(*) FROM $t")
    out="$out $t=$n"
  done
  printf '%s' "${out# }"
}

dump="${1:-}"
if [ -z "$dump" ]; then
  dump="$(ls -t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -1 || true)"
fi
if [ -z "$dump" ] || [ ! -f "$dump" ]; then
  echo "no backup found: ${dump:-$BACKUP_DIR/*.sql.gz}" >&2
  exit 1
fi

log "drill start: dump=$(basename "$dump")"

# 临时库 + 第一遍灌入（模拟已有结构+数据的目标库）
cleanup
psql_admin -c "CREATE DATABASE ${DRILL_DB};" >/dev/null
gunzip -c "$dump" | docker exec -i "$PG_CONTAINER" psql -U "$DB_USER" -d "$DRILL_DB" \
  -v ON_ERROR_STOP=1 -q

before="$(counts_of "$DRILL_DB")"
if [ -z "$before" ]; then
  log "drill FAILED: restored db has no tables (dump=$dump)"
  exit 1
fi

# 制造脏库：核心表连同其引用一并清空 —— 覆盖恢复必须把行数修回快照值
if psql_db "$DRILL_DB" -c "SELECT to_regclass('public.\"User\"') IS NOT NULL" | grep -q '^t$'; then
  psql_db "$DRILL_DB" -c 'TRUNCATE "User" CASCADE;' >/dev/null
fi

# 关键路径：覆盖恢复（旧写法在这里逐表 already exists）
if ! "$SCRIPT_DIR/pg-restore.sh" "$dump" "$DRILL_DB" --yes >/dev/null; then
  log "drill FAILED: overwrite restore returned non-zero (dump=$dump)"
  exit 1
fi

after="$(counts_of "$DRILL_DB")"
if [ "$before" != "$after" ]; then
  log "drill FAILED: counts mismatch after overwrite restore"
  echo "  before: $before" >>"$DRILL_LOG"
  echo "  after : $after" >>"$DRILL_LOG"
  exit 1
fi

ntables=$(printf '%s\n' "$before" | wc -w)
log "drill ok: dump=$(basename "$dump") tables=$ntables overwrite-restore verified (counts identical)"
