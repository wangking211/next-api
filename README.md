# AI Gateway（AI API 中转站）

多模型、多服务商 AI API 网关，支持用户注册、自助管理 API Key、BYOK 与平台托管混合渠道、调用用量统计。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 后端 | NestJS 10 + Prisma 6 + TypeScript |
| 前端 | React 18 + Vite + Ant Design + TanStack Query |
| 数据库 | PostgreSQL 16 |
| 缓存/限流 | Redis 7 |
| 包管理 | pnpm workspace (monorepo) |

## 目录结构

```
AiProject/
├─ apps/
│  ├─ api/          NestJS 后端（auth / keys / channels / models / gateway*）
│  └─ web/          React 控制台
├─ docker-compose.yml   PG + Redis
└─ pnpm-workspace.yaml
```

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 启动数据库（Docker Desktop 需先运行）
pnpm db:up

# 3. 初始化数据库
pnpm prisma:migrate

# 3.5 （可选）灌入演示数据：模型/平台渠道/演示用户+余额+Key（幂等，可重复执行）
pnpm seed

# 4. 启动 API (http://localhost:3000/api) 与 Web (http://localhost:5173)
pnpm dev
```

首次启动会自动创建管理员（见 `apps/api/.env`）：

```
admin / admin123456   (BOOTSTRAP_ADMIN_*)
```

`pnpm seed` 会额外灌入 **56 个主流模型**（OpenAI `gpt-5.x`/`gpt-6`、Anthropic `claude-opus-5.x`/`sonnet-5`、Gemini `3.x`、DeepSeek / Moonshot / Qwen / 智谱 / xAI / Mistral / Doubao / MiniMax，含占位默认定价，请按上游价目调整）、创建演示账号 `demo / demo123456`、3 个平台渠道（指向 `DEMO_UPSTREAM_URL`，默认 `http://localhost:4001`），并在首次运行时打印一个平台 Key。配合 `node tests/mock-upstream.mjs` 启动 mock 上游即可零依赖验证网关全链路。

清理 e2e 测试残留、保留演示数据：

```bash
pnpm cleanup --dry-run   # 预览将删除的内容
pnpm cleanup             # 执行清理
```

## 当前进度

- [x] **P0** 脚手架：monorepo、docker-compose、NestJS + Prisma + Redis、Vite Web 骨架
- [x] **P1** 数据模型 + 认证：User / ApiKey / Channel / ModelCatalog / RequestLog / UsageDaily；注册、登录、JWT、角色守卫、管理员自举
- [x] **P2** Key 与渠道：平台 key 签发（SHA-256 存储，仅展示一次）、BYOK/平台渠道 CRUD（上游 key AES-256-GCM 加密）、模型目录
- [x] **P3** 网关转发：`/v1/chat/completions` OpenAI 兼容（流式/非流式）、Anthropic 双向协议转换、渠道选择 + 自动故障转移
- [x] **P4** 计量与限流：token 计费、请求日志、Redis 限流、额度控制、日聚合
- [x] **P5** 前端控制台：登录注册、总览（用量/图表）、Key/渠道/模型/日志页面
- [x] **P6** 打磨：Dockerfile（api/web + nginx）、单元测试 + e2e、安全加固、文档
- [x] **P7** 计费与充值：用户余额、管理员充值/调整、平台渠道按成本扣费、余额不足拦截、账单明细
- [x] **P8** 兑换码：管理员批量生成/作废、用户自助兑换充值、并发安全防重复兑换
- [x] **P9** Gemini 适配器：Google AI 原生协议双向转换（含流式与图片），同时支持 `\r\n` SSE 分隔
- [x] **P10** 渠道异常与操作审计：连续失败阈值自动禁用 + 告警 webhook、全局审计拦截器、管理员审计查询
- [x] **P11** 官网首页与登录页：公开落地页（Hero/数据条/特性/四步上手/模型定价表）、分栏品牌登录页、设计令牌与 SEO 元数据、登录后 `?redirect=` 回跳、404 页面
- [x] **P12** 智能路由（评分制）：五维评分（价格/速度/稳定性/质量/分流噪声）+ 策略权重、模型级熔断冷却与半开恢复、429/配额特征识别与指数退避、渠道每日限额排除、会话粘性、L1 质量分与 L2 被动信号（详见「智能路由」章节）
- [x] **P13** 在线充值：JAIPay 聚合微信/支付宝（PC 扫码 / 手机收银台）、下单与订单轮询、回调 MD5 验签 + 幂等入账、金额核对、充值订单列表

## API 一览（当前）

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/health` | 健康检查（DB/Redis） | 公开 |
| GET | `/api/config` | 公共配置（积分汇率等） | 公开 |
| GET | `/api/public/models` | 落地页模型定价表（启用中的模型目录 + provider 列表，价格 `$ / 1M tokens`） | 公开 |
| GET | `/api/public/stats` | 落地页数据条（模型数 / 提供商数 / 启用渠道数 / 协议覆盖） | 公开 |
| POST | `/api/auth/register` | 注册 | 公开 |
| POST | `/api/auth/login` | 登录 | 公开 |
| GET | `/api/auth/me` | 当前用户 | 登录 |
| GET/POST | `/api/keys` | 列出/创建平台 key | 登录 |
| PATCH/DELETE | `/api/keys/:id` | 更新/删除 key | 登录 |
| GET | `/api/channels` | 渠道列表（分页+过滤：`name/provider/status/ownerType/model`） | 登录（管理员可见全部/按归属过滤） |
| GET | `/api/channels/available-models` | 当前用户可用模型（按渠道分组） | 登录 |
| POST | `/api/channels` | 创建渠道 | 登录（PLATFORM 仅管理员） |
| POST | `/api/channels/:id/test` | 渠道连通性测试（传 `models` 批量，缺省测试该渠道全部模型） | 属主或管理员 |
| POST | `/api/channels/test-connection` | 测试未保存的渠道配置（新增/编辑弹窗用，支持 `models` 批量） | 登录 |
| POST | `/api/channels/fetch-models` | 拉取上游可用模型列表（OpenAI/Anthropic/Gemini 协议 `/models`，Base URL 漏填 `/v1` 自动回退；仅传 `channelId` 时复用已存配置） | 登录 |
| PATCH/DELETE | `/api/channels/:id` | 更新/删除渠道 | 属主或管理员 |
| GET | `/api/models` | 模型目录 | 登录 |
| POST/PATCH/DELETE | `/api/models[/:id]` | 模型维护 | 管理员 |
| GET | `/api/usage/summary` | 用量汇总（`?days=&scope=all`） | 登录 |
| GET | `/api/usage/daily` | 按天用量 | 登录 |
| GET | `/api/usage/analytics` | 使用分析（按模型/渠道/用户聚合） | 登录 |
| GET | `/api/usage/logs` | 调用明细（分页+过滤：`model/status/stream/userId/channelId/q/from/to`） | 登录 |
| GET | `/api/usage/logs/:id` | 调用详情（含输入/输出内容） | 登录 |
| GET | `/api/billing/me` | 账户余额 | 登录 |
| GET | `/api/billing/transactions` | 账单明细（分页） | 登录 |
| POST | `/api/billing/redeem` | 兑换码充值 | 登录 |
| POST | `/api/billing/pay/orders` | 创建在线充值订单（微信/支付宝，返回二维码内容/收银台链接） | 登录 |
| GET | `/api/billing/pay/orders` | 我的充值订单（`?limit=`，最近 N 笔） | 登录 |
| GET | `/api/billing/pay/orders/:id` | 单笔充值订单状态（前端轮询） | 登录（属主/管理员） |
| GET | `/api/pay/jai/notify` | JAIPay 支付异步通知（GET Query，MD5 验签 + 幂等入账，返回 200） | 公开 |
| GET | `/api/admin/users` | 用户列表（`?q=` 搜索） | 管理员 |
| POST | `/api/admin/users/:id/recharge` | 充值 | 管理员 |
| POST | `/api/admin/users/:id/adjust` | 余额调整（可负） | 管理员 |
| POST | `/api/admin/redeem-codes` | 批量生成兑换码 | 管理员 |
| GET | `/api/admin/redeem-codes` | 兑换码列表（`?status=&batchId=`） | 管理员 |
| PATCH | `/api/admin/redeem-codes/:id/disable` | 作废兑换码 | 管理员 |
| GET | `/api/admin/audit-logs` | 操作审计（`?action=&actorId=`） | 管理员 |

### OpenAI 兼容网关（用平台 key 调用，base_url = `http://host/v1`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/models` | 列出当前 key 可用模型 |
| POST | `/v1/chat/completions` | 对话补全（支持 `stream: true`） |

鉴权：`Authorization: Bearer sk-...` 或 `x-api-key: sk-...`。

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-你的key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

**路由规则**：按 `model` 匹配渠道 → 用户自有 BYOK 渠道优先于平台渠道 → 同级按 `priority` 降序、`weight` 加权随机 → 遇 5xx/429 自动故障转移到下一渠道。上游协议适配：**OpenAI 兼容透传**、**Anthropic 双向转换**、**Gemini 原生协议转换**。

## 控制台（Web）

访问 `http://localhost:5173`，功能页面：

- **首页（`/`，公开）**：产品落地页 —— Hero、平台数据条、能力卡片、四步快速上手（cURL/Python/Node 代码示例与复制）、**实时模型定价表**（读 `/api/public/models`，可搜索、按服务商筛选）。已登录时导航栏显示「进入控制台」
- **登录/注册（`/login`，公开）**：左右分栏品牌页，支持 `?redirect=` 登录后回跳原页面；已登录访问自动进入控制台
- **总览**：近 30 天请求/成功率/Token/费用，每日用量柱状图，**模型/渠道/用户用量排行**，最近调用（管理员可切「查看全部用户」）
- **API Key**：创建（明文仅展示一次）、额度/RPM 配置、启停、删除
- **渠道**：BYOK 与平台渠道（管理员）的新增/**编辑**/启停/删除，支持按名称/服务商/模型/状态/归属过滤与分页；连通性测试支持**多模型批量**（并发 3，逐个展示成功/失败、HTTP 状态、延迟、上游错误与原始响应）——列表「测试」测该渠道全部模型，新增/编辑弹窗内「测试连通性」测当前所选模型。创建时默认按所选服务商**预选全部主流模型**，并提供「**获取上游模型** / 选本服务商全部 / 选全部推荐 / 清空」快捷操作：「获取上游模型」调用上游 `/models` 接口拉取该服务商**全部真实可用模型**（OpenAI/Anthropic/Gemini 三种协议，Base URL 漏填 `/v1` 时自动回退；编辑已存渠道自动复用已存 Key）。模型候选内置 56 个主流模型（含 `gpt-5.5/5.6/6`、`claude-opus-5.5`、`gemini-3` 等新一代，可搜索、也可手动输入任意模型名）。**BYOK 渠道隐藏「逐模型定价」与「定价」入口**（上游费用用户自付、平台不扣费，折扣仅影响折算展示，无计费意义）
- **可用模型**：按渠道分组展示当前用户可调用的模型，点击复制模型名（调用时只填模型名，网关自动路由）
- **模型**：目录与定价（管理员可维护）
- **调用日志**：分页明细（时间/模型/服务商/Key/渠道/流式、tokens、费用、延迟、状态），支持按模型/状态/类型/用户/关键词/时间范围**筛选**；点「详情」可查看**完整输入（messages）与输出（模型回复）**、错误信息与 token 明细
- **余额与账单**：账户余额、**在线充值（微信/支付宝）**、兑换码充值、充值/消费/调整流水
- **在线充值**：金额档位（1 / 10 / 50 / 100 / 500 元，可自定义）+ 支付方式（通用收银台 / 微信扫码 / 支付宝扫码）；PC 展示二维码（antd `QRCode`）、手机端自动跳转收银台；下单后每 3 秒轮询订单状态，到账自动刷新余额；下方「充值订单」列表可回看最近 8 笔
- **用户管理**（管理员）：用户列表、充值、余额调整
- **兑换码**（管理员）：批量生成、复制导出、按状态筛选、作废；**有效期支持快速选择**（永久有效 / 7 天 / 1 个月 / 3 个月 / 6 个月 / 1 年 / 自定义截止时间）
- **操作审计**（管理员）：写操作留痕（操作者、动作、状态、IP），支持过滤

**计费规则**：平台托管渠道按调用成本从用户余额扣费，余额不足时拦截；BYOK（用户自带上游 Key）渠道不扣费，仅记录用量。用户可通过**在线充值（微信/支付宝）**、兑换码自助充值。

**在线充值（JAIPay）**：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JAIPAY_MCH_NO` / `JAIPAY_APP_ID` / `JAIPAY_APP_SECRET` | — | 商户号/应用 ID/应用密钥（JAIPay 管理端获取）；**三项齐全才开通在线支付**，否则前端只显示兑换码充值 |
| `JAIPAY_BASE_URL` | `https://pay.zxixing.com` | 网关地址 |
| `JAIPAY_NOTIFY_URL` / `JAIPAY_RETURN_URL` | `https://xiaopuyun.com/api/pay/jai/notify` / `…/billing` | 异步通知与同步跳转地址 |
| `PAY_CNY_PER_USD` | `7.1` | 充值汇率：1 美元 = N 元人民币（决定「充 N 元到账多少积分」） |
| `CREDITS_PER_USD` | `100` | 1 美元 = N 积分；`充值积分 = 元 ÷ PAY_CNY_PER_USD × CREDITS_PER_USD` |

> 「1 元 = 100 积分」需同时把 `CREDITS_PER_USD` 改为 `710`（积分改为人民币分口径，全站积分显示数字 ×7.1，**价值不变**：1 积分 = 0.01 元）。
> 入账口径：订单金额（分）→ `creditUsd = 元 ÷ PAY_CNY_PER_USD`（USD 额度）；回调校验金额一致 + 状态机 `PENDING→PAID` 只入账一次，并写 `BalanceTransaction(RECHARGE)` 流水。

**渠道健康**：连续失败达到 `CHANNEL_FAILURE_THRESHOLD`（默认 5）次的渠道自动禁用（表中标记「自动禁用」），重新启用会清零失败计数；配置 `ALERT_WEBHOOK_URL` 可推送告警。

## 测试

```bash
# 单元测试（crypto / token 估算 / SSE 用量收集 / Anthropic+Gemini 转换 / 渠道排序与智能路由评分 / 路由指标 / 渠道健康 / 计费 / 兑换码 / 支付验签与回调入账）
pnpm test

# 端到端测试：自动拉起 mock 上游 + API，依次跑全部用例（P1-P4、P7-P10）
# 需先启动数据库并迁移，且已构建 API
pnpm --filter @ai-gateway/api build
pnpm test:e2e
```

## Docker 部署

```bash
# 一键构建并启动 postgres + redis + api + web
pnpm docker:up
# web 控制台: http://localhost:8080
# 网关直连:   http://localhost:3000/v1
```

生产部署时通过环境变量注入安全密钥并开启生产校验：

```bash
JWT_SECRET=$(openssl rand -base64 48) \
ENCRYPTION_KEY=$(openssl rand -hex 32) \
BOOTSTRAP_ADMIN_PASSWORD='强密码' \
NODE_ENV=production \
docker compose --profile full up -d --build
```

### 生产服务器部署

生产环境必须**同时加载** `docker-compose.yml` 与 `docker-compose.prod.yml`。只加载前者会使用开发默认值（Postgres/Redis 端口对外暴露、api 使用开发库密码），切勿在生产这样操作。

```bash
# 1) 准备环境变量（首次）
cp .env.production.example .env      # 再填入真实密钥
# 或直接在 .env 中固定 compose 文件组合，之后即可用简写命令：
#   COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml

# 2) 一键部署（拉取代码 → 串行构建 → 重建 → 健康检查）
./deploy.sh

# 等价的手动命令
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile full up -d --build
```

`deploy.sh` 会串行构建镜像（`COMPOSE_PARALLEL_LIMIT=1`）以降低小内存服务器 OOM 风险，并在结束时检查容器健康与 `/api/health`。

典型服务器拓扑：容器仅监听回环地址（api `127.0.0.1:3000`、web `127.0.0.1:8081`），由宿主机 nginx 反向代理并终结 TLS（如 `xiaopuyun.com` → `127.0.0.1:8081`，Certbot 管理证书）。

宿主机 nginx 站点配置已纳入版本管理，见 [`ops/nginx/`](ops/nginx/README.md)。

> **`deploy.sh` 不碰宿主机 nginx**，它只负责拉代码、构建镜像、重建容器和健康检查。改了 `ops/nginx/*.conf` 后需单独生效：
>
> ```bash
> scp ops/nginx/xiaopuyun.com.conf root@<服务器>:/etc/nginx/conf.d/aigateway.conf
> ssh root@<服务器> 'nginx -t && systemctl reload nginx'   # -t 不通过则不会 reload，线上不中断
> ```
>
> 生效后核对两者一致：`diff ops/nginx/xiaopuyun.com.conf root@<服务器>:/etc/nginx/conf.d/aigateway.conf`。同机若还跑着别的 nginx 站点（其他 `conf.d/*.conf`），只替换本项目的 `aigateway.conf`，不要动别人的配置。

### 自动部署（GitHub Actions）

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 会在 `main` 分支 **CI 成功后自动** SSH 到服务器执行 `./deploy.sh`，也可在 Actions 页面手动触发。

#### 1. 生成部署密钥并安装公钥

```bash
# 生成专用密钥（无口令）
ssh-keygen -t ed25519 -f ~/.ssh/aigw_deploy -N '' -C 'github-actions-deploy'

# 把公钥装到服务器（或手动追加到 ~/.ssh/authorized_keys）
ssh-copy-id -i ~/.ssh/aigw_deploy.pub root@<服务器>

# 验证可用（BatchMode 禁止回退到密码，失败即报错）
ssh -i ~/.ssh/aigw_deploy -o BatchMode=yes -o IdentitiesOnly=yes root@<服务器> 'echo key-auth-ok'
```

#### 2. 在仓库中添加 Secrets

打开 **Settings → Secrets and variables → Actions → New repository secret**，逐个添加：

| Secret | 必填 | 值 |
| --- | --- | --- |
| `DEPLOY_HOST` | 是 | 服务器地址，如 `170.106.82.224` |
| `DEPLOY_SSH_KEY` | 是 | 上一步私钥的**全文**，含 `-----BEGIN/END OPENSSH PRIVATE KEY-----`（用 `cat ~/.ssh/aigw_deploy` 取） |
| `DEPLOY_USER` | 否 | SSH 用户，默认 `root` |
| `DEPLOY_PATH` | 否 | 仓库目录，默认 `/opt/AiProject` |

#### 3. 触发部署与验证

- 推送到 `main` 后 CI 通过即自动部署；或在 **Actions → Deploy → Run workflow** 手动触发；
- **未配置 `DEPLOY_HOST` / `DEPLOY_SSH_KEY` 时，Deploy 会以明确报错失败（属预期）**，配置 secrets 后重跑该任务即可；
- 部署脚本自身会校验容器健康与 `/api/health`，失败会在日志中体现。

## 计费口径（BYOK 与平台渠道）

| 场景 | 扣余额 | 日志 / 统计 | Key 费用额度 `costLimit` |
| --- | --- | --- | --- |
| 平台渠道（`Channel.ownerType=PLATFORM`） | ✅ 渠道售价 × 用户倍率 | 计入「费用（实扣）」 | 累计 |
| 用户自有 BYOK 渠道（`USER`） | ❌ 上游费用由用户自己付 | 只记折算金额，界面标注「未计费 / BYOK 折算」 | 不累计 |

- 口径字段：`RequestLog.chargeable`（该次是否实扣）、`UsageDaily.billedCost`（按日实扣）、`RequestLog.cost`（折算总额，供用量与毛利分析）。三者由迁移 `20260928090000_chargeable_billed_cost` 按渠道归属回填历史数据（含 `ApiKey.costUsed`）。
- 展示：总览与使用统计的「费用（实扣）」与余额扣款同口径，`BYOK 折算` 单列显示；调用日志对未计费行显示 `未计费` 标签；CSV 导出含「折算费用 / 实际扣费」两列。
- 管理员毛利 = 实收 − 上游实付（`billedCost - billedUpstreamCost`）；BYOK 两条腿都是 0，不产生幻影毛利。
- 故障转移：BYOK 上游 5xx/429 会回落到平台渠道，回落成功的那一次按平台口径扣费（`gateway.controller.ts`）。
- API Key 额度分工：`quotaLimit` 按 token 管用量（BYOK 也计），`costLimit` 只管真实花费。

## 智能路由（评分排序 / 熔断 / 每日限额）

同一模型有多个可用渠道时，网关按「硬分层 + 五维评分」选渠道，而不是单纯按优先级：

1. **硬分层（不参与评分）**：`tier`（用户 BYOK 优先于平台渠道）→ `priority`（渠道/模型人工指定，越大越优先）；
2. **层内评分**：`score = Σ 权重 × 归一化维度`，各维 min-max 归一化到 [0,1]，无数据回退 0.5（中性）。
   全无指标时退化为「成本升序 + 分流噪声」，与旧的 `cost asc` 排序兼容。

| 维度 | 含义 | 计算 |
| --- | --- | --- |
| price 价格 | 越便宜越优 | 路由成本 = 绝对成本 > 官方价 × 上游折扣；未知成本排末位 |
| speed 速度 | 低时延 | 0.6×平均时延 + 0.2×慢请求(≥3s)占比 + 0.2×吞吐(tokens/s) |
| stability 稳定性 | 滑窗成功率 | 拉普拉斯平滑 `(ok+1)/(ok+fail+2)`，无数据恰为 0.5 |
| quality 质量 | L1 人工分 + L2 被动信号 | `0.5×qualityScore + 0.5×(0.6×有效回复率 + 0.4×平均输出长度)` |
| noise 分流噪声 | 让渠道 `weight` 真正生效 | gumbel 竞速 `-ln(U)/weight`，权重越大越占优 |

**策略权重（Σ=1）**，Key 级 `ApiKey.routingStrategy` 优先，缺省用 `ROUTING_STRATEGY`：

| 策略 | price | speed | stability | quality | noise |
| --- | --- | --- | --- | --- | --- |
| `BALANCED` 均衡（默认） | .30 | .20 | .25 | .20 | .05 |
| `CHEAPEST` 最省 | .65 | .05 | .15 | .10 | .05 |
| `FASTEST` 最快 | .10 | .55 | .25 | .05 | .05 |
| `STABLE` 最稳 | .10 | .15 | .60 | .10 | .05 |
| `QUALITY_FIRST` 质量优先 | .10 | .10 | .20 | .55 | .05 |

- **设置入口**：控制台「密钥」创建弹窗可选路由策略（留空 = 全局默认）；渠道「逐模型定价」表可填 **质量分** `qualityScore`（0~2，1=正常：官方直连 1.0、可用中转 0.85、疑似降智 0.6）。
- **故障熔断（模型级）**：Redis 记录 (渠道,模型) 连续失败数 `cf`，达 `CHANNEL_MODEL_FAILURE_THRESHOLD` 进入冷却 `CHANNEL_MODEL_COOLDOWN_MS`（开放期剔除候选，全部冷却则兜底放行）；冷却过期且失败未清 → **半开**（评分 ×0.1 仅作兜底探测），成功即复位。
- **限流/超限识别**：HTTP 429，或 4xx 错误体命中配额特征（`insufficient_quota` / `quota exceeded` / 日限额文案等）→ 记为「限流」：立即冷却并按连续次数指数退避（`CHANNEL_RATE_LIMIT_BASE_MS` ×2ⁿ，封顶 `CHANNEL_MODEL_COOLDOWN_MAX_MS`），**不累计**渠道 `failureCount`（不会因限流自动禁用），且故障转移到下一家。
- **每日限额**：渠道可配 `每日调用限额` / `每日 Token 限额`（渠道编辑表单，留空不限；自然日按 UTC+8，可用 `CHANNEL_LIMIT_DAY_OFFSET_HOURS` 调整）。Redis 按 `route:d:<渠道>:<自然日>` 计数，评分前剔除已超限渠道；全部超限时兜底放行。
- **半开恢复（渠道级）**：`autoDisabled` 渠道满 `CHANNEL_AUTO_REENABLE_MS` 冷却后懒式恢复（`failureCount` 置阈值-1，下一次失败即再禁用），无需定时任务。
- **会话粘性**：请求头 `x-session-id`（缺省用 `userId + 前 2 条 messages 前缀`）映射到与榜首同 `(tier, priority)` 组内候选，且 `score(偏好) ≥ ROUTING_STICKY_RATIO × score(榜首)` 才前置 —— 保住上游 prompt cache 但不为缓存死抱劣质渠道；`ROUTING_STICKY=false` 关闭。
- **错误分类**（`gateway.controller.ts`）：5xx/连接失败 → 计渠道失败数 + 指标；限流/超限 → 冷却不计失败；上游 401 → 只降路由分；拒答/内容过滤 → 只降质量分（不伤稳定性、不熔断）；其余客户端 4xx 不做任何渠道判罚。
- **观测**：`ROUTING_DEBUG=true` 时每次路由打印候选打分与标记（`!` 冷却、`#` 超限、`~` 半开）；控制台「使用统计 → 按渠道」含请求数/错误数/平均延迟/费用，「调用日志」支持按渠道过滤与 CSV 导出。

### 相关环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ROUTING_STRATEGY` | `BALANCED` | 全局默认路由策略 |
| `ROUTING_STICKY` / `ROUTING_STICKY_RATIO` | `true` / `0.8` | 会话粘性开关 / 前置得分比阈值 |
| `ROUTING_METRICS_WINDOW_MS` / `TTL_MS` / `RETRY_MS` | `600000` / `5000` / `10000` | 指标滑窗 / 快照缓存 / Redis 故障退避 |
| `ROUTING_DEBUG` | — | 打印评分日志 |
| `CHANNEL_MODEL_FAILURE_THRESHOLD` / `COOLDOWN_MS` / `COOLDOWN_MAX_MS` | `3` / `60000` / `600000` | 模型级熔断阈值与冷却（上限用于 429 退避封顶） |
| `CHANNEL_RATE_LIMIT_BASE_MS` | `30000` | 429 首次冷却时长（指数退避基数） |
| `CHANNEL_FAILURE_THRESHOLD` / `CHANNEL_AUTO_REENABLE_MS` | `5` / `900000` | 渠道级失败禁用阈值 / 自动禁用冷却 |
| `CHANNEL_LIMIT_DAY_OFFSET_HOURS` | `8` | 每日限额的自然日分界（UTC+8） |

## 安全说明

- 平台 key：仅存 SHA-256 哈希，明文只在创建时返回一次。
- 上游渠道 key：AES-256-GCM 加密存储，`ENCRYPTION_KEY`（32 字节 hex）务必在生产更换并妥善保管。
- 生产环境请替换 `JWT_SECRET` 与 `BOOTSTRAP_ADMIN_PASSWORD`；当 `NODE_ENV=production` 时启动会强制校验 `JWT_SECRET` / `ENCRYPTION_KEY`，不安全则拒绝启动。
- 已启用 `helmet` 安全响应头、请求体大小限制（25MB）、按 key 的 RPM 限流。
- 调用内容（输入/输出）默认记录到 `RequestLog`（`LOG_CONTENT=true`，单条上限 `LOG_CONTENT_MAX=20000` 字符）；如需隐私合规可设 `LOG_CONTENT=false` 仅保留元数据与 token。
