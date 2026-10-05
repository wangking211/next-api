/**
 * 邮件发送通道。
 *
 * 业务侧只依赖抽象 `MailService`：当前唯一实现是 SMTP（`SmtpMailService`），
 * 将来换成 Resend / SendGrid 等 HTTP API 通道时，只需新增一个实现类并在
 * `MailModule` 里换绑定，验证码流程一行都不用改。
 */
export type MailLocale = 'zh-CN' | 'zh-Hant' | 'en';

/** 验证码邮件的用途：注册验证 / 找回密码（决定邮件文案） */
export type MailPurpose = 'register' | 'reset';

export interface VerificationMail {
  code: string;
  purpose: MailPurpose;
  locale: MailLocale;
  /** 验证码有效时长（分钟），写进文案 */
  ttlMinutes: number;
}

/**
 * 邮件通道故障。带 `kind` 便于调用方区分：
 * - `not-configured`：SMTP 未配置（503，属于环境问题，不是用户问题）
 * - `send-failed`：SMTP 已配置但投递失败（502，稍后重试）
 */
export class MailError extends Error {
  constructor(
    readonly kind: 'not-configured' | 'send-failed',
    message: string,
  ) {
    super(message);
    this.name = 'MailError';
  }
}

/**
 * 浏览器语言 → 模板支持的三语。
 * 不认识的一律回退简体中文（与控制台默认语言一致）。
 */
export function normalizeMailLocale(raw?: string): MailLocale {
  const l = (raw ?? '').toLowerCase();
  if (l.startsWith('zh')) {
    return /hant|tw|hk|mo/.test(l) ? 'zh-Hant' : 'zh-CN';
  }
  if (l.startsWith('en')) return 'en';
  return 'zh-CN';
}

/** 邮件发送通道抽象（见文件头注释） */
export abstract class MailService {
  /**
   * 发件通道是否已配置。
   * false 时注册不强制验证码（保持旧行为，避免凭据未到位就卡死注册）、
   * 找回密码返回 `AUTH_MAIL_NOT_CONFIGURED`。
   */
  abstract readonly enabled: boolean;

  /** 投递一封验证码邮件；失败抛 {@link MailError} */
  abstract sendVerificationCode(to: string, mail: VerificationMail): Promise<void>;
}
