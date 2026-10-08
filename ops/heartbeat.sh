#!/usr/bin/env bash
#
# 宿主机心跳：容器栈故障的最后探测面。
#
# 应用内 watchdog 是进程内定时器 —— 镜像损坏、OOM 循环、migrate 失败导致 API
# 根本起不来时它一个字节都发不出去。本脚本由宿主机 cron 每分钟驱动，独立于
# 容器栈检查：
#   1. curl 探 /api/health（应用视角：db + redis）；
#   2. docker inspect 查各容器 running / health / RestartCount（容器视角）；
#   3. 有异常 → 推送 ALERT_WEBHOOK_URL（从 .env 提取；未配置则只写日志）；
#   4. 恢复后补一条恢复通知；同一状态在去重窗口内不重复推送。
#
# 环境变量：
#   ALERT_WEBHOOK_URL       告警地址（默认从 ENV_FILE 提取；留空 = 只记日志。
#                            当前 payload 为 {"text": "..."}，接入飞书/钉钉/企微
#                            等需换对应 msgtype 结构，拿到目标 URL 后再适配）
#   HEARTBEAT_URL           健康探针   默认 http://127.0.0.1:3000/api/health
#   HEARTBEAT_CONTAINERS    参与检查的容器（默认四个核心容器）
#   HEARTBEAT_STATE         状态文件   默认 /var/run/aigw-heartbeat.state
#   HEARTBEAT_LOG           事件日志   默认 /var/log/aigw-heartbeat.log
#   HEARTBEAT_RESTART_LIMIT 重启计数阈值 默认 3
#   HEARTBEAT_DEDUP_SEC     同状态告警去重窗口（秒） 默认 1800
# 不用 set -e：检查循环要跑完所有故障项再统一上报。
set -uo pipefail

ENV_FILE="${ENV_FILE:-/opt/AiProject/.env}"
HEARTBEAT_URL="${HEARTBEAT_URL:-http://127.0.0.1:3000/api/health}"
HEARTBEAT_CONTAINERS="${HEARTBEAT_CONTAINERS:-ai-gateway-postgres ai-gateway-redis ai-gateway-api ai-gateway-web}"
HEARTBEAT_STATE="${HEARTBEAT_STATE:-/var/run/aigw-heartbeat.state}"
HEARTBEAT_LOG="${HEARTBEAT_LOG:-/var/log/aigw-heartbeat.log}"
HEARTBEAT_RESTART_LIMIT="${HEARTBEAT_RESTART_LIMIT:-3}"
HEARTBEAT_DEDUP_SEC="${HEARTBEAT_DEDUP_SEC:-1800}"

# 不整文件 source .env（值里的特殊字符会炸脚本），只提取告警地址
if [ -z "${ALERT_WEBHOOK_URL:-}" ] && [ -f "$ENV_FILE" ]; then
  ALERT_WEBHOOK_URL="$(grep -E '^ALERT_WEBHOOK_URL=' "$ENV_FILE" \
    | tail -1 | cut -d= -f2- | tr -d "\"'" || true)"
fi

problems=()

code="$(curl -fsS -m 5 -o /dev/null -w '%{http_code}' "$HEARTBEAT_URL" 2>/dev/null || true)"
[ "$code" = "200" ] || problems+=("health probe $HEARTBEAT_URL -> HTTP ${code:-000}")

for c in $HEARTBEAT_CONTAINERS; do
  running="$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo missing)"
  if [ "$running" != "true" ]; then
    problems+=("container $c not running ($running)")
    continue
  fi
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$c" 2>/dev/null || echo unknown)"
  case "$health" in
    healthy | none) ;;
    *) problems+=("container $c health=$health") ;;
  esac
  restarts="$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null || echo 0)"
  case "$restarts" in '' | *[!0-9]*) restarts=0 ;; esac
  if [ "$restarts" -gt "$HEARTBEAT_RESTART_LIMIT" ]; then
    problems+=("container $c restart loop (RestartCount=$restarts)")
  fi
done

now="$(date +%s)"
prev="$(cut -d' ' -f1,2 "$HEARTBEAT_STATE" 2>/dev/null || echo '0 ok')"
prev_ts="${prev%% *}"
prev_status="${prev##* }"
case "$prev_ts" in '' | *[!0-9]*) prev_ts=0 ;; esac

# 只写日志不回显：cron 的 stdout 重定向到同一个日志，避免一条事件两行
push() {
  local line
  line="$(date -u +%FT%TZ) $1"
  echo "$line" >>"$HEARTBEAT_LOG"
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    local payload
    payload="$(printf '{"text":"%s"}' "$(printf '%s' "$1" | tr '"' "'")")"
    if ! curl -fsS -m 10 -H 'Content-Type: application/json' -d "$payload" \
      "$ALERT_WEBHOOK_URL" >/dev/null 2>&1; then
      echo "$(date -u +%FT%TZ) webhook push FAILED: $1" >>"$HEARTBEAT_LOG"
    fi
  fi
}

if [ "${#problems[@]}" -eq 0 ]; then
  if [ "$prev_status" = "fail" ]; then
    push "aigw RECOVERED: heartbeat OK ($(date -u +%FT%TZ))"
    echo "$now ok" >"$HEARTBEAT_STATE"
  fi
  exit 0
fi

# 失败：去重窗口内不重复吵
if [ "$prev_status" = "fail" ] && [ $((now - prev_ts)) -lt "$HEARTBEAT_DEDUP_SEC" ]; then
  exit 0
fi
msg="$(printf '%s; ' "${problems[@]}")"
push "aigw heartbeat FAIL: ${msg%; }"
echo "$now fail" >"$HEARTBEAT_STATE"
