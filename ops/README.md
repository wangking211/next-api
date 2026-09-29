# 运维手册（Ops）

## 数据库备份

- 脚本：`ops/pg-backup.sh` —— 对运行中的 `ai-gateway-postgres` 容器执行 `pg_dump | gzip`
- 调度：crontab 每日 **03:17**（`crontab -l` 查看），日志 `/var/log/aigw-backup.log`
- 产出：`/var/backups/aigw/ai_gateway-<时间戳>.sql.gz`，gzip 完整性校验失败会删除文件并以非零码退出
- 保留：`RETENTION_DAYS`（默认 14 天）自动清理
- 可调环境变量：`BACKUP_DIR` / `RETENTION_DAYS` / `PG_CONTAINER` / `DB_USER` / `DB_NAME`

### 手动备份

```bash
/opt/AiProject/ops/pg-backup.sh
ls -lh /var/backups/aigw/
```

### 恢复（单文件）

```bash
gunzip -c /var/backups/aigw/ai_gateway-<ts>.sql.gz \
  | docker exec -i ai-gateway-postgres psql -U aigw -d ai_gateway
```

> ⚠️ 恢复到生产库会覆盖同名表。恢复前先停 API（`docker compose stop api`），恢复完成再 `up -d`。

### 恢复演练（建议每月一次）

把最近备份恢复进**临时库**核对行数，再删除临时库：

```bash
LATEST=$(ls -t /var/backups/aigw/*.sql.gz | head -1)
docker exec ai-gateway-postgres psql -U aigw -d postgres -c 'CREATE DATABASE ai_gateway_drill;'
gunzip -c "$LATEST" | docker exec -i ai-gateway-postgres psql -U aigw -d ai_gateway_drill -v ON_ERROR_STOP=1
docker exec ai-gateway-postgres psql -U aigw -d ai_gateway_drill \
  -c "SELECT (SELECT count(*) FROM \"User\") AS users,
             (SELECT count(*) FROM \"Channel\") AS channels,
             (SELECT count(*) FROM \"ApiKey\") AS keys;"
docker exec ai-gateway-postgres psql -U aigw -d postgres -c 'DROP DATABASE ai_gateway_drill;'
```

- 演练判据：`ON_ERROR_STOP=1` 零错误、关键表行数与源库一致、临时库可删除
- 上次演练：**2026-09-29**（备份 `ai_gateway-20260929-031701.sql.gz`，13 张表，User/Channel/ApiKey/ModelCatalog 行数与源库一致，0 错误）

### 异机/异地上传（⚠️ 待接入）

当前备份与数据库**同盘**（`/var/backups/aigw` 与 Docker 数据盘同机），单盘故障或误迁移仍会全量丢失。
拿到对象存储凭据后，在 `pg-backup.sh` 末尾（gzip 校验通过后）追加上传：

```bash
# 方式一：rclone（S3 / WebDAV / 阿里 OSS 等皆可）
rclone copy "$out" remote:aigw-backup/

# 方式二：AWS CLI
aws s3 cp "$out" s3://your-bucket/aigw-backup/
```

接入时同步做两件事：① 用 `age`/`gpg` 对 `.sql.gz` 再加密（密钥异地保存，勿放同盘）；② 配置上传失败告警。

### 备份失败告警

脚本失败（gzip 校验不过）以非零码退出，目前仅体现在 `/var/log/aigw-backup.log`。如需主动通知，
可在 crontab 外包一层：失败时 curl 推送 `ALERT_WEBHOOK_URL`（该配置项已存在，用于渠道健康与支付告警）。
