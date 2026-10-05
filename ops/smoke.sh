#!/usr/bin/env bash
# 部署后冒烟测试（deploy.sh 据此触发回滚）。全部通过返回 0，任一失败返回 1。
#
# 覆盖：API 健康（db/redis）、网关协议错误形状（OpenAI/Anthropic）、x-request-id 回显、
#       登录校验管道、指标端点在位、前端静态资源、web nginx → api 两跳链路、
#       domestic 分组镜像一致性（第 9 节，需一次管理登录，凭据取自 .env 的 SMOKE_ADMIN_*）。
# 第 1–8 节为无副作用请求（401/400 快速失败，不写库、不触限流计数），可反复执行；
# 第 9 节执行一次管理登录后只读比对分组/渠道模型集合（不写库）。
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

# 9) domestic 分组镜像一致性（防漂移）：分组可见模型 ⇄ 其绑定渠道模型并集必须 1:1 镜像。
#    凭据：优先环境变量 SMOKE_ADMIN_IDENTIFIER/SMOKE_ADMIN_PASSWORD，其次部署目录 .env 中的
#    同名键（SMOKE_ENV_FILE 可覆盖路径），最后回退 .env 的 BOOTSTRAP_ADMIN_*（仅在从未改过
#    引导密码的环境有效）。缺凭据 / 服务器无 jq / 未找到 domestic 分组 → 打印 skip 放行
#    （其他环境可能无此分组），分组一旦存在就必须镜像一致——渠道加模型忘改分组（或反向）
#    会在这里 FAIL 并触发回滚。
mirror_check() {
  local env_file="${SMOKE_ENV_FILE:-.env}"
  local ident="${SMOKE_ADMIN_IDENTIFIER:-}" pass="${SMOKE_ADMIN_PASSWORD:-}"
  local token group_json gid group_models channel_models only_group only_channel n_ch n_m

  if ! command -v jq >/dev/null; then
    echo "  skip domestic 镜像一致性（服务器无 jq）"
    return
  fi
  if [[ -z "$ident" && -f "$env_file" ]]; then
    ident=$(grep -E '^SMOKE_ADMIN_IDENTIFIER=' "$env_file" | head -1 | cut -d= -f2- | tr -d "\"'" || true)
    [[ -z "$ident" ]] &&
      ident=$(grep -E '^BOOTSTRAP_ADMIN_USERNAME=' "$env_file" | head -1 | cut -d= -f2- | tr -d "\"'" || true)
  fi
  if [[ -z "$pass" && -f "$env_file" ]]; then
    pass=$(grep -E '^SMOKE_ADMIN_PASSWORD=' "$env_file" | head -1 | cut -d= -f2- | tr -d "\"'" || true)
    [[ -z "$pass" ]] &&
      pass=$(grep -E '^BOOTSTRAP_ADMIN_PASSWORD=' "$env_file" | head -1 | cut -d= -f2- | tr -d "\"'" || true)
  fi
  if [[ -z "$ident" || -z "$pass" ]]; then
    echo "  skip domestic 镜像一致性（缺管理凭据：SMOKE_ADMIN_*）"
    return
  fi

  request "$API/api/auth/login" -X POST -H 'content-type: application/json' \
    -d "$(jq -n --arg i "$ident" --arg p "$pass" '{identifier:$i,password:$p}')"
  if [[ "$CODE" != 200 && "$CODE" != 201 ]]; then
    echo "  FAIL domestic 镜像检查：管理登录失败（status=$CODE）"
    FAIL=1
    return
  fi
  token=$(jq -r '.accessToken // empty' <<<"$BODY")
  if [[ -z "$token" ]]; then
    echo "  FAIL domestic 镜像检查：登录响应无 accessToken"
    FAIL=1
    return
  fi

  request "$API/api/groups" -H "authorization: Bearer $token"
  if [[ "$CODE" != 200 ]]; then
    echo "  FAIL domestic 镜像检查：GET /api/groups status=$CODE"
    FAIL=1
    return
  fi
  group_json=$(jq -c '.[] | select(.name == "domestic")' <<<"$BODY" | head -1)
  if [[ -z "$group_json" ]]; then
    echo "  skip domestic 镜像一致性（未找到 domestic 分组）"
    return
  fi
  gid=$(jq -r '.id' <<<"$group_json")
  group_models=$(jq -r '.models // [] | .[]' <<<"$group_json" | sort -u)

  # pageSize=100：并集必须覆盖全部渠道——默认 20 条分页会漏掉第 2 页的绑定渠道
  request "$API/api/channels?pageSize=100" -H "authorization: Bearer $token"
  if [[ "$CODE" != 200 ]]; then
    echo "  FAIL domestic 镜像检查：GET /api/channels status=$CODE"
    FAIL=1
    return
  fi
  channel_models=$(jq -r --arg gid "$gid" \
    '.items[] | select([.groups[]?.id] | index($gid) != null) | .models // [] | .[]' \
    <<<"$BODY" | sort -u)
  n_ch=$(jq -r --arg gid "$gid" \
    '[.items[] | select([.groups[]?.id] | index($gid) != null)] | length' <<<"$BODY")
  n_m=$(jq -r '.models // [] | length' <<<"$group_json")

  only_group=$(comm -23 <(printf '%s\n' "$group_models") <(printf '%s\n' "$channel_models") | grep -v '^$' || true)
  only_channel=$(comm -13 <(printf '%s\n' "$group_models") <(printf '%s\n' "$channel_models") | grep -v '^$' || true)
  if [[ -n "$only_group" || -n "$only_channel" ]]; then
    echo "  FAIL domestic 镜像漂移（分组 ${n_m} 模型 ⇄ ${n_ch} 绑定渠道并集；仅分组有: ${only_group:-—}；仅渠道有: ${only_channel:-—}）"
    FAIL=1
  else
    echo "  ok   domestic 镜像一致（${n_m} 模型 ⇄ ${n_ch} 绑定渠道）"
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

# 3b) 视频端点已注册（未带 key → 401；若被套上 /api 前缀会变成 404 Cannot POST）
request "$API/v1/videos" -X POST -H 'content-type: application/json' -d '{}'
check "/v1/videos 路由已注册（401 而非 404）" 401
request "$API/v1/videos/task_smoke_probe"
check "/v1/videos/:id 路由已注册（401 而非 404）" 401

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

# 9) domestic 分组镜像一致性（详见 mirror_check）
echo "  —— domestic 分组镜像一致性"
mirror_check

echo
if [[ "$FAIL" -ne 0 ]]; then
  echo "==> 冒烟失败 ❌"
  exit 1
fi
echo "==> 冒烟通过 ✅"
