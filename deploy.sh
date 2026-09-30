#!/usr/bin/env bash
#
# 生产部署：拉取最新代码 → 构建镜像 → 重建容器 → 健康检查 + 冒烟测试；
# 任一环节失败自动回滚到部署前版本（代码 + 镜像快照），退出码非 0 供 CI 识别。
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
#
# 回滚说明：
#   - 部署前把当前 api/web 镜像打上 ai-gateway-*:rollback 快照，并记录 git SHA；
#     失败时代码 reset 回 PREV_SHA、快照镜像顶回原名并 force-recreate。
#   - 回滚不覆盖数据库迁移（本项目迁移均为增量加表/加列，旧版本代码兼容新 schema）。
#   - 若本次构建失败（容器未被触碰），直接退出不回滚——服务仍在旧版本上运行。
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile full)
SERVICES=(ai-gateway-api ai-gateway-web ai-gateway-postgres ai-gateway-redis)

if [[ ! -f .env ]]; then
  echo "错误：缺少 .env，请先复制 .env.production.example 并填写密钥。" >&2
  exit 1
fi

# ---------- 部署前快照（回滚依据） ----------
PREV_SHA=$(git rev-parse HEAD)
for svc in api web; do
  img=$(docker inspect --format '{{.Config.Image}}' "ai-gateway-$svc" 2>/dev/null || true)
  if [[ -n "$img" ]]; then
    docker tag "$img" "ai-gateway-$svc:rollback" 2>/dev/null || true
    echo "回滚快照：ai-gateway-$svc:rollback ← $img"
  fi
done

# 等待四个核心容器全部健康（0=通过；容器无 healthcheck 视为健康）
wait_healthy() {
  local i states healthy=0
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
    if ! grep -qE 'starting|unhealthy' <<<"$states"; then
      healthy=1
      break
    fi
    sleep 5
  done
  [[ "$healthy" -eq 1 ]]
}

# 回滚：代码回退到部署前 SHA，镜像快照顶回原名并强制重建容器，最终以退出码 1 结束
rollback() {
  local reason="$1" svc img restored=0
  echo
  echo "==> 部署未通过（$reason），开始回滚到 $PREV_SHA"
  if [[ "$(git rev-parse HEAD)" != "$PREV_SHA" ]]; then
    git reset --hard "$PREV_SHA" >/dev/null
    echo "  代码已回退：$(git --no-pager log --oneline -1)"
  fi
  for svc in api web; do
    img=$(docker inspect --format '{{.Config.Image}}' "ai-gateway-$svc" 2>/dev/null || true)
    if [[ -n "$img" ]] && docker image inspect "ai-gateway-$svc:rollback" >/dev/null 2>&1; then
      if docker tag "ai-gateway-$svc:rollback" "$img"; then
        echo "  镜像已回滚：$img ← ai-gateway-$svc:rollback"
        restored=1
      fi
    fi
  done
  if [[ "$restored" -eq 1 ]]; then
    "${COMPOSE[@]}" up -d --force-recreate --no-build --remove-orphans || true
  else
    echo "  无可用镜像快照（首次部署？），跳过镜像回滚" >&2
  fi
  wait_healthy || echo "  回滚后仍有容器未就绪，请人工介入！" >&2
  "${COMPOSE[@]}" ps || true
  echo "==> 回滚完成（数据库迁移不回退，均为增量变更）❌" >&2
  exit 1
}

echo "==> 拉取最新代码"
git pull --ff-only origin main
git --no-pager log --oneline -1

echo
echo "==> 构建镜像（串行构建，降低小内存服务器 OOM 风险）"
if ! COMPOSE_PARALLEL_LIMIT=1 "${COMPOSE[@]}" build; then
  echo "构建失败：容器仍在旧版本上运行，本次未部署。" >&2
  exit 1
fi

echo
echo "==> 重建并启动"
if ! "${COMPOSE[@]}" up -d --remove-orphans; then
  rollback "容器重建失败"
fi

echo
echo "==> 等待健康检查"
if ! wait_healthy; then
  rollback "健康检查超时"
fi

echo
echo "==> 容器状态"
"${COMPOSE[@]}" ps

echo
echo "==> 冒烟测试（ops/smoke.sh）"
if ! bash ./ops/smoke.sh; then
  rollback "冒烟测试失败"
fi

echo
echo "==> 部署完成 ✅"
