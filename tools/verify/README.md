# tools/verify — 巡检与验收脚本

把原先散落在临时目录的一次性脚本收编进仓库，便于复跑、复核与交接。
与 `scripts/model-audit.mjs`（模型对账）同一套约定：**凭据只从环境读取，不入库、不打印**。

## 脚本清单

| 命令                  | 脚本                         | 性质                             | 用途                                                                                    |
| --------------------- | ---------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm verify:status`  | `channel-status.mjs`         | 只读                             | 渠道优先级/权重/状态/模型数/分组快照，解释流量为什么这么路由                            |
| `pnpm verify:probe`   | `channel-probe.mjs`          | 只读（调用平台内置 testChannel） | 全渠道 × 全模型连通性巡检，失败按余额/模型不存在/鉴权/限流/媒体模型归类                 |
| `pnpm verify:residue` | `residue-check.mjs`          | 只读                             | 复核测试数据是否清理干净：临时 key、模型目录嫌疑行、模型数为 0 的渠道、分组范围         |
| `pnpm verify:deploy`  | `deploy-acceptance.mjs`      | **含写操作**                     | 发布后验收：站点/前端入口、邮件通道状态、找回密码链路、错误口令 401、管理员重置口令往返 |
| `pnpm audit:models`   | `../scripts/model-audit.mjs` | 只读（可 `AIGW_APPLY=true` 写）  | 上游清单 vs 渠道声明 vs 模型目录 对账                                                   |

## 运行

```bash
# 只读巡检
AIGW_PASSWORD=... pnpm verify:status
AIGW_PASSWORD=... pnpm verify:residue
AIGW_PASSWORD=... AIGW_CHANNEL=tokenfleetAI pnpm verify:probe   # 只巡检指定渠道

# 发布后验收（会临时改管理员口令，跑完自动还原）
AIGW_PASSWORD=... pnpm verify:deploy
```

## 环境变量

| 变量                   | 默认                     | 说明                                                                     |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `AIGW_BASE_URL`        | `https://xiaopuyun.com`  | 平台地址                                                                 |
| `AIGW_IDENTIFIER`      | `admin`                  | 管理员账号                                                               |
| `AIGW_PASSWORD`        | —                        | 管理员口令（与 `AIGW_TOKEN` 二选一）                                     |
| `AIGW_TOKEN`           | —                        | 直接给 accessToken，优先于账号口令；`verify:deploy` 仍需 `AIGW_PASSWORD` |
| `AIGW_CHANNEL`         | —                        | 只处理指定渠道（名称或 id，逗号分隔）                                    |
| `AIGW_CHUNK`           | `8`                      | 探针分块大小（DTO 上限 20）                                              |
| `AIGW_SUSPECT`         | `verify,tmp,test,tmpkey` | 残留检查的追加嫌疑关键字                                                 |
| `AIGW_VERIFY_REGISTER` | 关                       | `verify:deploy` 额外验证「免验证码注册」，**会残留一个永久账号**         |

## 约定

1. **只做连通性，不做真实生成调用**：探针走平台内置 `testChannel`，不产生模型输出与费用。
2. **临时数据用后即删**：巡检中创建的 key / 模型 / 分组当场删除，`verify:residue` 事后复核。
3. **凭据不入库**：口令只从环境变量读，输出里不打印口令与 token。
4. **写操作显式标注**：目前只有 `verify:deploy` 会写（改管理员口令并自动还原），失败时它会打印还原指引。
5. **线上没有删除用户的接口**：所以验收用「管理员口令往返」而不是注册临时账号，避免残留。

## 分工

- 发布前：`pnpm typecheck && pnpm lint && pnpm test && pnpm build` 四门 + CI e2e
- 发布后：`pnpm verify:deploy`（控制台链路）
- 例行：`pnpm verify:status` / `pnpm verify:probe` / `pnpm audit:models`
- 巡检之后：`pnpm verify:residue`
