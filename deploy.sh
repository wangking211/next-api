#!/usr/bin/env bash
#
# 生产部署：拉取最新代码 → 构建镜像 → 重建容器 → 健康检查。
#
# 用法（在仓库根目录）：
#   ./deploy.sh
#
# 前置条件：
#   - 已复制 .env.production.example 为 .env 并填入真实密钥
#   - Docker Engine + Docker Compose v2.24+（docker-compose.prod.yml 使用了 !reset / !override）
#
# 注意：必须同时加载 docker-compose.yml 与 docker-compose.prod.yml。只加载前者会
# 使用开发默认值（数据库端口对外暴露、api 用开发库密码），生产环境务必勿用。
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile full)
SERVICES=(ai-gateway-api ai-gateway-web ai-gateway-postgres ai-gateway-redis)

if [[ ! -f .env ]]; then
  echo "错误：缺少 .env，请先复制 .env.production.example 并填写密钥。" >&2
  exit 1
fi

echo "==> 拉取最新代码"
git pull --ff-only origin main
git --no-pager log --oneline -1

echo
echo "==> 构建镜像（串行构建，降低小内存服务器 OOM 风险）"
COMPOSE_PARALLEL_LIMIT=1 "${COMPOSE[@]}" build

echo
echo "==> 重建并启动"
"${COMPOSE[@]}" up -d --remove-orphans

echo
echo "==> 等待健康检查"
for i in $(seq 1 40); do
  states=$(docker inspect --format \
    '{{.Name}}={{if .State.Health}}{{.State.Health.Status}}{{else}}no-health{{end}}' \
    "${SERVICES[@]}" 2>/dev/null || true)
  if [[ -z "$states" ]]; then
    echo "  [$i] 容器尚未创建，等待…"
    sleep 5
    continue
  fi
  echo "  [$i] $(echo "$states" | tr '\n' ' ')"
  if grep -qE 'starting|unhealthy' <<<"$states"; then
    sleep 5
    continue
  fi
  break
done

echo
echo "==> 容器状态"
"${COMPOSE[@]}" ps

echo
echo "==> 网关健康检查"
curl -fsS http://127.0.0.1:3000/api/health && echo

echo
echo "==> 部署完成 ✅"
