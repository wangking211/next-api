import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect as tlsConnect } from 'tls';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from './metrics.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 证书告警重发间隔：处于过期预警期时最多每天提醒一次 */
const CERT_ALERT_REPEAT_MS = DAY_MS;

function num(config: ConfigService, key: string, fallback: number): number {
  const v = Number(config.get<string>(key, ''));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 看门狗：周期自检 + 证书到期预警，异常/恢复推 ALERT_WEBHOOK_URL。
 *
 * - 健康检查：DB/Redis 探活，只在状态迁移时告警（起始为 up 不告警、恢复时发 recovered），
 *   并写 `service_up{component}` 指标供 Prometheus 侧做 uptime 告警规则
 * - 证书检查：TLS 握手读取对端证书 validTo，剩余天数 ≤ 阈值时告警（每 24h 重发一次），
 *   每次检查都写 `cert_expiry_days{host}` 指标
 * - 首次执行延迟 WATCHDOG_INITIAL_DELAY_MS，避开启动高峰；定时器 unref 不阻塞进程退出
 */
@Injectable()
export class WatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatchdogService.name);
  private readonly enabled: boolean;
  private readonly initialDelayMs: number;
  private readonly healthIntervalMs: number;
  private readonly certIntervalMs: number;
  private readonly certHost: string;
  private readonly certPort: number;
  private readonly certWarnDays: number;
  private readonly webhook?: string;

  private initTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private certTimer?: NodeJS.Timeout;
  /** 上一次健康状态：null = 尚未检查过（首检为 up 不告警） */
  private lastHealth: 'up' | 'down' | null = null;
  /** 上次证书告警时间（0 = 无待重发的预警） */
  private lastCertAlertAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('WATCHDOG_ENABLED', 'true') !== 'false';
    this.initialDelayMs = num(config, 'WATCHDOG_INITIAL_DELAY_MS', 30_000);
    this.healthIntervalMs = num(config, 'WATCHDOG_HEALTH_INTERVAL_MS', 300_000);
    this.certIntervalMs = num(config, 'WATCHDOG_CERT_INTERVAL_MS', 6 * 60 * 60 * 1000);
    this.certHost = (config.get<string>('CERT_CHECK_HOST', 'xiaopuyun.com') ?? '').trim();
    this.certPort = num(config, 'CERT_CHECK_PORT', 443);
    this.certWarnDays = num(config, 'CERT_EXPIRY_WARN_DAYS', 14);
    this.webhook = config.get<string>('ALERT_WEBHOOK_URL') || undefined;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('看门狗已禁用（WATCHDOG_ENABLED=false）');
      return;
    }
    this.initTimer = setTimeout(() => {
      this.healthTimer = setInterval(() => void this.runHealth(), this.healthIntervalMs);
      this.certTimer = setInterval(() => void this.runCert(), this.certIntervalMs);
      this.initTimer = undefined;
      void this.runHealth();
      void this.runCert();
    }, this.initialDelayMs);
    this.initTimer.unref();
  }

  onModuleDestroy(): void {
    for (const t of [this.initTimer, this.healthTimer, this.certTimer]) {
      if (t) clearTimeout(t);
    }
    this.initTimer = this.healthTimer = this.certTimer = undefined;
  }

  /** DB/Redis 探活：仅状态迁移时告警（首次为 up 静默记录，down→up 发恢复通知） */
  async runHealth(): Promise<void> {
    const down: string[] = [];
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      down.push('db');
    }
    try {
      const pong = await this.redis.client.ping();
      if (pong !== 'PONG') down.push('redis');
    } catch {
      down.push('redis');
    }

    this.metrics.setServiceUp('db', !down.includes('db'));
    this.metrics.setServiceUp('redis', !down.includes('redis'));

    const state = down.length ? 'down' : 'up';
    const prev = this.lastHealth;
    if (state === prev) return;
    this.lastHealth = state;

    if (state === 'down') {
      this.logger.error(`健康检查失败：${down.join(', ')} 不可用`);
      await this.sendAlert({ type: 'service_degraded', down, at: new Date().toISOString() });
    } else if (prev === 'down') {
      this.logger.log('健康检查恢复：db 与 redis 均可用');
      await this.sendAlert({ type: 'service_recovered', at: new Date().toISOString() });
    } else {
      // 首次检查且健康：留一条启动后的确认日志，便于部署验收
      this.logger.log('健康检查通过：db up / redis up');
    }
  }

  /** 证书剩余天数：每次检查更新指标；进入预警期告警（24h 重发），续期后复位 */
  async runCert(): Promise<void> {
    if (!this.certHost) return;
    try {
      const { validTo, daysLeft } = await this.probeCert(this.certHost, this.certPort);
      this.metrics.setCertExpiryDays(this.certHost, daysLeft);
      this.logger.log(
        `证书检查 ${this.certHost}:${this.certPort} 有效期至 ${validTo}（剩余 ${daysLeft} 天）`,
      );
      if (daysLeft <= this.certWarnDays) {
        const now = Date.now();
        if (now - this.lastCertAlertAt < CERT_ALERT_REPEAT_MS) return;
        this.lastCertAlertAt = now;
        this.logger.warn(`证书将在 ${daysLeft} 天后过期：${this.certHost}（${validTo}）`);
        await this.sendAlert({
          type: 'cert_expiring',
          host: this.certHost,
          daysLeft,
          validTo,
          warnDays: this.certWarnDays,
          at: new Date().toISOString(),
        });
      } else if (this.lastCertAlertAt) {
        // 已续期：复位，下一轮进入预警期时重新告警
        this.lastCertAlertAt = 0;
      }
    } catch (e) {
      this.metrics.setCertExpiryDays(this.certHost, -1);
      this.logger.warn(
        `证书检查失败 ${this.certHost}:${this.certPort}: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  /** TLS 握手读取对端证书（不校验证书链：只关心有效期，且避免中间证书缺失干扰） */
  private probeCert(
    host: string,
    port: number,
  ): Promise<{ validTo: string; daysLeft: number }> {
    return new Promise((resolve, reject) => {
      const socket = tlsConnect(
        { host, port, servername: host, rejectUnauthorized: false, timeout: 10_000 },
        () => {
          const cert = socket.getPeerCertificate();
          socket.end();
          const raw = cert?.valid_to;
          const validTo = raw ? new Date(raw) : null;
          if (!validTo || Number.isNaN(validTo.getTime())) {
            reject(new Error('对端未返回有效证书'));
            return;
          }
          const daysLeft = Math.floor((validTo.getTime() - Date.now()) / DAY_MS);
          resolve({ validTo: validTo.toISOString(), daysLeft });
        },
      );
      socket.on('timeout', () => socket.destroy(new Error('TLS 握手超时')));
      socket.on('error', (e) => reject(e));
    });
  }

  /** 与渠道自动禁用告警同一形状的 webhook 推送（未配置则仅日志） */
  private async sendAlert(payload: Record<string, unknown>): Promise<void> {
    if (!this.webhook) return;
    try {
      await fetch(this.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      this.logger.warn(`告警 webhook 发送失败: ${(e as Error)?.message ?? e}`);
    }
  }
}
