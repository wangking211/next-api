#!/usr/bin/env bash
# 部署后冒烟测试（deploy.sh 据此触发回滚）。全部通过返回 0，任一失败返回 1。
#
# 覆盖：API 健康（db/redis）、网关协议错误形状（OpenAI/Anthropic）、x-request-id 回显、
#       登录校验管道、指标端点在位、前端静态资源、web nginx → api 两跳链路。
# 全部为无副作用请求（401/400 快速失败，不写库、不触限流计数），可反复执行。
#
# 断言统一走 body_has()/status_is()：子串用 case 匹配、状态码显式比较，
# 不在调用处手写 [[ == *'...' * ]] 通配符（易漏星号导致误判）。
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

# body_has <子串>：最近一次 request 的响应体是否包含该子串
body_has() {
  case "$BODY" in
    *"$1"*) return 0 ;;
    *) return 1 ;;
  esac
}

# check <描述> <期望状态码> [必须包含的子串]：不满足则记录失败并打印现场
check() {
  local desc="$1" want="$2" sub="${3:-}"
  if [[ "$CODE" == "$want" ]] && { [[ -z "$sub" ]] || body_has "$sub"; }; then
    echo "  ok   $desc"
  else
    echo "  FAIL $desc（status=$CODE body=${BODY:0:200}）"
    FAIL=1
  fi
}

echo "==> 冒烟：API=$API  WEB=$WEB"

# 1) 健康：db 与 redis 都 up 才 200 ok（任一不可用返回 503 degraded）
request "$API/api/health"
check "/api/health status=ok" 200 '"status":"ok"'

# 2) 网关无 key → 401 且 OpenAI 错误形状（GatewayErrorFilter 生效）
request "$API/v1/models"
check "/v1/models 401 OpenAI 形状" 401 'authentication_error'

# 3) Anthropic 形状：POST /v1/messages 无 key → 401 {type:'error'}
request "$API/v1/messages" -X POST -H 'content-type: application/json' -d '{}'
check "/v1/messages 401 Anthropic 形状" 401 '"type":"error"'

# 4) 请求关联：合法 x-request-id 原样回显
REQ_ID_HDR=$(curl -sS -m 15 -D - -o /dev/null -H 'x-request-id: deploy-smoke' \
  "$API/v1/models" 2>&1 || true)
if [[ "$REQ_ID_HDR" == *'x-request-id: deploy-smoke'* ]]; then
  echo "  ok   x-request-id 回显"
else
  echo "  FAIL x-request-id 回显（响应头未找到）"
  FAIL=1
fi

# 5) 登录校验管道：空 body → 400（请求止于 ValidationPipe，无副作用）
request "$API/api/auth/login" -X POST -H 'content-type: application/json' -d '{}'
check "/api/auth/login 空 body 400" 400

# 6) 指标端点在位：200（开放）/ 401（token 不符）/ 403（生产未配置 METRICS_TOKEN）
request "$API/api/metrics"
case "$CODE" in
  200 | 401 | 403) echo "  ok   /api/metrics 在位（HTTP $CODE）" ;;
  *)
    echo "  FAIL /api/metrics 在位（status=$CODE body=${BODY:0:200}）"
    FAIL=1
    ;;
esac

# 7) 前端静态资源
request "$WEB/"
check "前端 index.html" 200 'html'

# 8) 两跳链路：web nginx → api
request "$WEB/api/health"
check "web nginx → api /api/health" 200 '"status":"ok"'

echo
if [[ "$FAIL" -ne 0 ]]; then
  echo "==> 冒烟失败 ❌"
  exit 1
fi
echo "==> 冒烟通过 ✅"
