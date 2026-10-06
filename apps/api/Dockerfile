# ---------- build ----------
FROM node:22-slim AS build
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# 仅拷贝 workspace 清单，利用缓存安装依赖
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @ai-gateway/api...

COPY apps/api apps/api
RUN pnpm --filter @ai-gateway/api exec prisma generate \
  && pnpm --filter @ai-gateway/api build

# ---------- runtime ----------
FROM node:22-slim AS runtime
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app

# 运行期重新装一遍「仅生产依赖」：devDeps（jest / typescript / @nestjs/cli / ts-node / @types）
# 与根 workspace 的 lint 工具链（eslint / prettier / react-doctor）不再进镜像，
# 这是镜像从 1.2GB 瘦身的关键；与旧的「整份 node_modules 拷过来」相比少了这些包。
# 装完必须清掉 pnpm 自己的缓存（store 305MB + registry 元数据 351MB，实测占镜像 711MB）：
# node_modules 里的文件是从 store 硬链过来的，删掉 store 不会破坏它们；清理与安装同一层，
# 这些字节才不会进镜像。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --prod --filter @ai-gateway/api... \
  && rm -rf /root/.local/share/pnpm /root/.cache/pnpm /root/.cache/node

# 容器启动命令先跑 `prisma migrate deploy`（见 docker-compose.yml），所以 schema 与 migrations
# 必须随镜像带走；客户端在本阶段生成 —— prisma CLI 已放进 dependencies，generate 只依赖 schema。
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
RUN pnpm --filter @ai-gateway/api exec prisma generate

COPY --from=build /app/apps/api/dist ./apps/api/dist

USER node

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
