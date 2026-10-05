import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { MailError, MailService, type VerificationMail } from './mail.service';
import { buildVerificationMail } from './mail.templates';

/**
 * SMTP 邮件通道：配置了 `SMTP_HOST` 即启用（可用 `MAIL_ENABLED=false` 显式关闭）。
 *
 * 未配置时 `enabled=false`：注册不强制验证码、找回密码返回 `AUTH_MAIL_NOT_CONFIGURED`，
 * 保证凭据未到位时线上注册流程不受影响。
 */
@Injectable()
export class SmtpMailService extends MailService {
  private readonly logger = new Logger(MailService.name);
  readonly enabled: boolean;
  private readonly from: string;
  private readonly transporter?: nodemailer.Transporter;

  constructor(config: ConfigService) {
    super();
    const host = config.get<string>('SMTP_HOST')?.trim();
    const off = config.get<string>('MAIL_ENABLED', 'true') === 'false';
    this.enabled = Boolean(host) && !off;
    // 发件人：优先 MAIL_FROM，未填则用主机名推一个 no-reply（仅本地开发会出现这种情况）
    this.from =
      config.get<string>('MAIL_FROM')?.trim() ||
      `AI Gateway <no-reply@${host ?? 'localhost'}>`;

    if (!this.enabled || !host) return;

    const port = Number(config.get<string>('SMTP_PORT', '465'));
    const user = config.get<string>('SMTP_USER')?.trim();
    const pass = config.get<string>('SMTP_PASS');
    // SMTP_SECURE 显式配置优先；未配置时按惯例 465=SSL、其余不加密
    const secureRaw = config.get<string>('SMTP_SECURE');
    const secure = secureRaw != null && secureRaw !== '' ? secureRaw === 'true' : port === 465;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      ...(user && pass ? { auth: { user, pass } } : {}),
    });
    // 只打配置摘要，绝不打印密码
    this.logger.log(`SMTP channel ready: host=${host} port=${port} secure=${secure}`);
  }

  async sendVerificationCode(to: string, mail: VerificationMail): Promise<void> {
    if (!this.enabled || !this.transporter) {
      throw new MailError('not-configured', 'SMTP is not configured');
    }
    const body = buildVerificationMail(mail);
    try {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject: body.subject,
        text: body.text,
        html: body.html,
      });
    } catch (e) {
      // 记录完整原因（不含密码）供排查，向上只抛稳定类型
      this.logger.error(`send mail to ${to} failed: ${(e as Error)?.message ?? e}`);
      throw new MailError('send-failed', (e as Error)?.message ?? 'send failed');
    }
  }
}
