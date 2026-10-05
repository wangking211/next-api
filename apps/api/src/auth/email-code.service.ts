import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import { RedisService } from '../redis/redis.service';
import {
  MailError,
  MailService,
  normalizeMailLocale,
  type MailPurpose,
} from '../mail/mail.service';

export interface IssueResult {
  /** 重发冷却秒数，供前端做倒计时 */
  cooldownSeconds: number;
}

/**
 * 邮箱验证码：签发（Redis 落码 + 投递邮件）与校验。
 *
 * 安全模型（与登录限流同思路，但**全部 fail-closed**——验证码是闸门，
 * Redis 挂了宁可报 503 也不能放行）：
 * - 码 6 位数字，TTL `MAIL_CODE_TTL_SECONDS`（默认 600s），一次性；
 * - 同邮箱同用途重发冷却 `MAIL_CODE_COOLDOWN_SECONDS`（默认 60s），
 *   用 `SET NX` 原子占位，避免并发把冷却打穿；
 * - 校验失败计数，达 `MAIL_CODE_MAX_ATTEMPTS`（默认 5）次即作废该码；
 * - IP 维度独立限流，防止把本服务当成邮件轰炸中继。
 */
@Injectable()
export class EmailCodeService {
  private readonly logger = new Logger(EmailCodeService.name);
  readonly cooldownSeconds: number;
  private readonly ttlSeconds: number;
  private readonly maxAttempts: number;
  private readonly ipLimit: number;
  private readonly ipWindow: number;

  constructor(
    private readonly mail: MailService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.ttlSeconds = Number(config.get<string>('MAIL_CODE_TTL_SECONDS', '600'));
    this.cooldownSeconds = Number(config.get<string>('MAIL_CODE_COOLDOWN_SECONDS', '60'));
    this.maxAttempts = Number(config.get<string>('MAIL_CODE_MAX_ATTEMPTS', '5'));
    this.ipLimit = Number(config.get<string>('MAIL_IP_LIMIT', '20'));
    this.ipWindow = Number(config.get<string>('MAIL_IP_WINDOW', '300'));
  }

  /** 邮件通道是否已启用（决定注册是否强制验证码） */
  get enabled(): boolean {
    return this.mail.enabled;
  }

  /** 验证码有效时长（分钟），随 mail-status 下发给前端做提示 */
  get codeTtlMinutes(): number {
    return Math.max(Math.round(this.ttlSeconds / 60), 1);
  }

  private codeKey(email: string, purpose: MailPurpose): string {
    return `mail:code:${purpose}:${email}`;
  }

  private cooldownKey(email: string, purpose: MailPurpose): string {
    return `mail:cool:${purpose}:${email}`;
  }

  private tryKey(email: string, purpose: MailPurpose): string {
    return `mail:try:${purpose}:${email}`;
  }

  private notConfigured(): HttpException {
    return new HttpException(
      { code: 'AUTH_MAIL_NOT_CONFIGURED', message: 'Email service is not configured' },
      503,
    );
  }

  private unavailable(e: unknown): HttpException {
    this.logger.error(`verification code store unavailable: ${(e as Error)?.message ?? e}`);
    return new HttpException(
      { code: 'AUTH_CODE_UNAVAILABLE', message: 'Verification code service unavailable' },
      503,
    );
  }

  private invalid(): HttpException {
    return new HttpException(
      { code: 'AUTH_CODE_INVALID', message: 'Invalid or expired verification code' },
      400,
    );
  }

  private tooFrequent(seconds: number): HttpException {
    return new HttpException(
      {
        code: 'AUTH_CODE_RESEND_TOO_FREQUENT',
        message: `Too many code requests. Please try again in ${seconds} seconds.`,
        details: { seconds },
      },
      429,
    );
  }

  /**
   * Redis 操作统一兜底：任何底层异常（连接断开、超时……）都转成
   * `AUTH_CODE_UNAVAILABLE` 503。验证码是安全闸门，出错必须 fail-closed，
   * 绝不能把原始错误漏成 500，更不能因为「读不到就当没有」而放行。
   */
  private async redisOp<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw this.unavailable(e);
    }
  }

  /**
   * 签发一枚验证码并（按需）投递邮件。
   *
   * `deliver=false` 用于「查无此邮箱」的找回密码请求：同样走 IP 限流、
   * 同样返回 200 与冷却秒数（响应形态与真实请求一致），但不落码、不发信、
   * 也不占冷却位——否则任何人探测一个邮箱就能把它接下来 60 秒的收码权打掉。
   */
  async issue(
    email: string,
    purpose: MailPurpose,
    locale?: string,
    ip?: string,
    opts: { deliver?: boolean } = {},
  ): Promise<IssueResult> {
    if (!this.mail.enabled) throw this.notConfigured();
    const deliver = opts.deliver !== false;
    const target = email.toLowerCase().trim();

    await this.assertIpAllowed(ip);

    if (!deliver) return { cooldownSeconds: this.cooldownSeconds };

    const cooldownKey = this.cooldownKey(target, purpose);
    const claimed = await this.redisOp(() =>
      this.redis.client.set(cooldownKey, '1', 'EX', this.cooldownSeconds, 'NX'),
    );
    if (claimed !== 'OK') {
      const left = await this.redisOp(async () =>
        Math.max(await this.redis.client.ttl(cooldownKey), 1),
      );
      throw this.tooFrequent(left);
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.redisOp(async () => {
      await this.redis.client.set(this.codeKey(target, purpose), code, 'EX', this.ttlSeconds);
      await this.redis.client.del(this.tryKey(target, purpose));
    });

    try {
      await this.mail.sendVerificationCode(target, {
        code,
        purpose,
        locale: normalizeMailLocale(locale),
        ttlMinutes: this.codeTtlMinutes,
      });
    } catch (e) {
      // 投递失败：把码与冷却位一并回滚，用户可以立刻重试而不是干等冷却
      await this.rollback(target, purpose);
      if (e instanceof MailError && e.kind === 'not-configured') throw this.notConfigured();
      this.logger.error(`send verification mail to ${target} failed: ${(e as Error)?.message}`);
      throw new HttpException(
        { code: 'AUTH_MAIL_SEND_FAILED', message: 'Failed to send verification email' },
        502,
      );
    }

    return { cooldownSeconds: this.cooldownSeconds };
  }

  /** 校验验证码；不删除（成功后由调用方 `clear`），失败按次数上限作废 */
  async verify(email: string, purpose: MailPurpose, code: string): Promise<void> {
    const target = email.toLowerCase().trim();
    const stored = await this.redisOp(() => this.redis.client.get(this.codeKey(target, purpose)));
    // 过期/不存在与填错同一文案：不给「码还存在只是错了」的区分依据
    if (!stored) throw this.invalid();
    if (stored !== code) {
      await this.redisOp(async () => {
        const tryKey = this.tryKey(target, purpose);
        const n = await this.redis.client.incr(tryKey);
        if (n === 1) await this.redis.client.expire(tryKey, this.ttlSeconds);
        if (n >= this.maxAttempts) {
          await this.redis.client.del(this.codeKey(target, purpose));
          await this.redis.client.del(tryKey);
          this.logger.warn(
            `verification code for ${target} invalidated after ${n} failures`,
          );
        }
      });
      throw this.invalid();
    }
  }

  /** 成功后清码与失败计数（一次性）；清不掉也不影响主流程 */
  async clear(email: string, purpose: MailPurpose): Promise<void> {
    const target = email.toLowerCase().trim();
    try {
      await this.redis.client.del(this.codeKey(target, purpose));
      await this.redis.client.del(this.tryKey(target, purpose));
    } catch {
      /* 仅残留到自然过期，不阻断主流程 */
    }
  }

  private async rollback(email: string, purpose: MailPurpose): Promise<void> {
    try {
      await this.redis.client.del(this.codeKey(email, purpose));
      await this.redis.client.del(this.cooldownKey(email, purpose));
    } catch {
      /* ignore */
    }
  }

  /** IP 维度限流；Redis 故障 fail-closed（验证码本身也依赖 Redis，放行没有意义） */
  private async assertIpAllowed(ip?: string): Promise<void> {
    if (!ip || this.ipLimit <= 0) return;
    const key = `mail:ip:${ip}`;
    const count = Number(
      (await this.redisOp(() => this.redis.client.get(key))) || 0,
    );
    if (count >= this.ipLimit) {
      throw new HttpException(
        { code: 'AUTH_IP_THROTTLED', message: 'Too many requests from your IP.' },
        429,
      );
    }
    await this.redisOp(async () => {
      const n = await this.redis.client.incr(key);
      if (n === 1) await this.redis.client.expire(key, this.ipWindow);
    });
  }
}
