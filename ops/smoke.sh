#!/usr/bin/env bash
# 部署后冒烟测试（deploy.sh 据此触发回滚）。全部通过返回 0，任一失败返回 1。
#
# 覆盖：API 健康（db/redis）、网关协议错误形状（OpenAI/Anthropic）、x-request-id 回显、
#       登录校验管道、指标端点在位、前端静态资源、web nginx → api 两跳链路。
# 全部为无副作用请求（401/400 快速失败，不写库、不触限流计数），可反复执行。
#
# 用法：ops/smoke.sh [api_base] [web_base]
#       默认 http://127.0.0.1:3000 与 http://127.0.0.1:8081（docker-compose.prod.yml 的绑定）
set -uo pipefail

API="${1:-http://127.0.0.1:3000}"
WEB="${2:-http://127.0.0.1:8081}"
CODE=000
BODY=''
FAIL=0

# request <url> [curl 参数...]：把 BODY 与状态码写入全局变量（网络失败 CODE=000）
request() {
  local url="$1" out
  shift
  if ! out=$(curl -sS -m 15 -w $'\n%{http_code}' "$@" "$url" 2>&1); then
    CODE=000
    BODY="$out"
    return
  fi
  CODE="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

ok() { echo "  ok   $1"; }
bad() {
  echo "  FAIL $1（status=$CODE body=${BODY:0:200}）"
  FAIL=1
}

echo "==> 冒烟：API=$API  WEB=$WEB"

# 1) 健康：db 与 redis 都 up 才 200 ok（任一不可用返回 503 degraded）
request "$API/api/health"
{ [[ "$CODE" == 200 && "$BODY" == *'"status":"ok"' ]]; } &&
  ok "/api/health status=ok" || bad "/api/health status=ok"

# 2) 网关无 key → 401 且 OpenAI 错误形状（GatewayErrorFilter 生效）
request "$API/v1/models"
{ [[ "$CODE" == 401 && "$BODY" == *'authentication_error'* ]]; } &&
  ok "/v1/models 401 OpenAI 形状" || bad "/v1/models 401 OpenAI 形状"

# 3) Anthropic 形状：POST /v1/messages 无 key → 401 {type:'error'}
request "$API/v1/messages" -X POST -H 'content-type: application/json' -d '{}'
{ [[ "$CODE" == 401 && "$BODY" == *'"type":"error"'* ]]; } &&
  ok "/v1/messages 401 Anthropic 形状" || bad "/v1/messages 401 Anthropic 形状"

# 4) 请求关联：合法 x-request-id 原样回显
REQ_ID_HDR=$(curl -sS -m 15 -D - -o /dev/null -H 'x-request-id: deploy-smoke' \
  "$API/v1/models" 2>&1 || true)
if [[ "$REQ_ID_HDR" == *'x-request-id: deploy-smoke'* ]]; then
  ok "x-request-id 回显"
else
  echo "  FAIL x-request-id 回显（响应头未找到）"
  FAIL=1
fi

# 5) 登录校验管道：空 body → 400（请求止于 ValidationPipe，无副作用）
request "$API/api/auth/login" -X POST -H 'content-type: application/json' -d '{}'
{ [[ "$CODE" == 400 ]]; } &&
  ok "/api/auth/login 空 body 400" || bad "/api/auth/login 空 body 400"

# 6) 指标端点在位：200（开放）/ 401（token 不符）/ 403（生产未配置 METRICS_TOKEN）
request "$API/api/metrics"
case "$CODE" in
  200 | 401 | 403) ok "/api/metrics 在位（HTTP $CODE）" ;;
  *) bad "/api/metrics 在位" ;;
esac

# 7) 前端静态资源
request "$WEB/"
{ [[ "$CODE" == 200 && "$BODY" == *'html'* ]]; } &&
  ok "前端 index.html" || bad "前端 index.html"

# 8) 两跳链路：web nginx → api
request "$WEB/api/health"
{ [[ "$CODE" == 200 && "$BODY" == *'"status":"ok"' ]]; } &&
  ok "web nginx → api /api/health" || bad "web nginx → api /api/health"

echo
if [[ "$FAIL" -ne 0 ]]; then
  echo "==> 冒烟失败 ❌"
  exit 1
fi
echo "==> 冒烟通过 ✅"
