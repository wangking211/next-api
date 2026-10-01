import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { redactSecrets } from '../common/redact.util';

@Injectable()
export class ChannelHealthService {
  private readonly logger = new Logger(ChannelHealthService.name);
  private readonly threshold: number;
  private readonly webhook?: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.threshold = Number(config.get<string>('CHANNEL_FAILURE_THRESHOLD', '5')) || 5;
    this.webhook = config.get<string>('ALERT_WEBHOOK_URL') || undefined;
  }

  /**
   * 调用成功：清零失败计数。
   *
   * knownFailureCount：调用方（路由 resolve 结果）已持有的失败计数。为 0 时本就是
   * no-op（where `failureCount > 0` 匹配不到行），直接跳过一次写查询；为 undefined
   * 或 >0 时保持原逻辑。并发窗口：若读后被其它请求递增，本次可能漏清，下次成功自愈。
   */
  async recordSuccess(channelId: string, knownFailureCount?: number): Promise<void> {
    if (knownFailureCount === 0) return;
    try {
      await this.prisma.channel.updateMany({
        where: { id: channelId, failureCount: { gt: 0 } },
        data: { failureCount: 0, lastErrorMsg: null },
      });
    } catch {
      /* ignore */
    }
  }

  /** 调用失败：累计失败次数，达到阈值自动禁用并告警。 */
  async recordFailure(channelId: string, message: string): Promise<void> {
    // 上游文案常带渠道密钥 → 先脱敏，再落库与告警
    const msg = redactSecrets(message);
    try {
      const channel = await this.prisma.channel.update({
        where: { id: channelId },
        data: {
          failureCount: { increment: 1 },
          lastErrorAt: new Date(),
          lastErrorMsg: msg.slice(0, 500),
        },
      });

      if (
        channel.failureCount >= this.threshold &&
        channel.status === ChannelStatus.ENABLED
      ) {
        // 条件更新：并发下只有一个请求能完成"启用→禁用"转换，避免重复告警
        const disabled = await this.prisma.channel.updateMany({
          where: { id: channelId, status: ChannelStatus.ENABLED },
          data: { status: ChannelStatus.DISABLED, autoDisabled: true },
        });
        if (disabled.count === 1) {
          this.logger.warn(
            `渠道 "${channel.name}" 连续失败 ${channel.failureCount} 次，已自动禁用`,
          );
          await this.sendAlert(channel, msg);
        }
      }
    } catch {
      /* ignore */
    }
  }

  /** 上游限流（429）：只记录错误现场，不累计 failureCount —— 连续限流不应直接打死渠道，
   *  抑制由路由层的 (渠道,模型) 冷却承担（且冷却会指数退避）。 */
  async recordRateLimited(channelId: string, message: string): Promise<void> {
    // 先脱敏再落库/打日志（上游限流文案里也会带密钥）
    const msg = redactSecrets(message);
    try {
      await this.prisma.channel.updateMany({
        where: { id: channelId },
        data: { lastErrorAt: new Date(), lastErrorMsg: msg.slice(0, 500) },
      });
      this.logger.warn(`渠道 ${channelId} 触发上游限流(429): ${msg.slice(0, 200)}`);
    } catch {
      /* ignore */
    }
  }

  private async sendAlert(channel: any, message: string): Promise<void> {
    if (!this.webhook) return;
    try {
      await fetch(this.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'channel_auto_disabled',
          channelId: channel.id,
          name: channel.name,
          provider: channel.provider,
          ownerType: channel.ownerType,
          failures: channel.failureCount,
          lastError: message,
          at: new Date().toISOString(),
        }),
      });
    } catch (e: any) {
      this.logger.warn(`告警 webhook 发送失败: ${e?.message}`);
    }
  }
}
