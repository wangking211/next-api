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

### 恢复（覆盖目标库）

```bash
# 恢复期间先停 API
docker compose stop api
/opt/AiProject/ops/pg-restore.sh /var/backups/aigw/ai_gateway-<ts>.sql.gz ai_gateway --yes
docker compose up -d api
```

> ⚠️ **不要**直接 `gunzip | psql`：纯格式 dump 只有 CREATE 没有 DROP，灌进已有结构的库会逐表报 `already exists`，而 psql 默认遇错继续，最终得到一个「部分成功、无法判断」的库。
>
> `pg-restore.sh` 的保证：① 先 `gzip -t` 验完整性，没过不碰目标库；② `DROP SCHEMA public CASCADE` 拼在语句流最前面；③ `--single-transaction + ON_ERROR_STOP=1` —— 任一步失败连同 DROP 一起回滚，**目标库保持原样**，全部成功才整体提交。

### 恢复演练（建议每月一次）

```bash
/opt/AiProject/ops/pg-restore-drill.sh        # 默认取最新备份
```

演练覆盖的是**真实恢复场景**：建临时库灌入备份（模拟已有结构+数据）→ `TRUNCATE` 核心表制造脏库 → 调 `pg-restore.sh` **覆盖恢复** → 逐表行数必须与覆盖前快照完全一致 → 自动删库。任何一步失败以非零退出，结果自动追加到 `ops/DRILL.log`（以该日志为准）。

- 上次演练：**2026-09-29**（手工灌空库路径，13 张表行数一致；覆盖恢复路径当时未验证 —— 即本次补上的缺口）

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

## 宿主机心跳告警

- 脚本：`ops/heartbeat.sh` —— 独立于容器栈的**最后探测面**：应用内 watchdog 随进程一起死，镜像损坏 / OOM 循环 / migrate 失败导致 API 起不来时它发不出任何东西
- 检查项：`/api/health`（db + redis）+ 四容器 `running` / `health` / `RestartCount`（重启计数超阈值 = 重启风暴）
- 调度：crontab 每分钟（`crontab -l` 查看），事件日志 `/var/log/aigw-heartbeat.log`
- 告警：`.env` 中 `ALERT_WEBHOOK_URL` 配置后推送；未配置只记日志；**同一状态 30 分钟内只推一次**，恢复后补发恢复通知（状态记录在 `/var/run/aigw-heartbeat.state`）
- 调参（环境变量）：`HEARTBEAT_URL` / `HEARTBEAT_CONTAINERS` / `HEARTBEAT_RESTART_LIMIT`（默认 3）/ `HEARTBEAT_DEDUP_SEC`（默认 1800）
- 自检：`HEARTBEAT_URL=http://127.0.0.1:1/health HEARTBEAT_STATE=/tmp/hb.state HEARTBEAT_LOG=/tmp/hb.log ops/heartbeat.sh` 应写入一条 FAIL；紧接着正常跑一次应写入 RECOVERED
