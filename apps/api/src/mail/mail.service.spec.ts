import { MailError, normalizeMailLocale } from './mail.service';
import { SmtpMailService } from './smtp-mail.service';
import type { ConfigService } from '@nestjs/config';
import { buildVerificationMail } from './mail.templates';
import * as nodemailer from 'nodemailer';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const createTransport = nodemailer.createTransport as jest.Mock;

function cfg(vars: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string, def?: string) => (key in vars ? vars[key] : def),
  } as unknown as ConfigService;
}

/**
 * 造一个 SmtpMailService；`transport` 传入时预置 createTransport 的返回值
 * （transport 在构造时就被捕获，必须先于构造设置）。
 */
function svc(vars: Record<string, string | undefined>, transport?: unknown) {
  // mockReset 而非 mockClear：连返回值一起清，避免上一个用例的 transport 泄漏进来
  createTransport.mockReset();
  if (transport !== undefined) createTransport.mockReturnValue(transport);
  return new SmtpMailService(cfg(vars));
}

const MAIL = { code: '123456', purpose: 'register', locale: 'zh-CN', ttlMinutes: 10 } as const;

describe('SmtpMailService 启用判定', () => {
  it('未配置 SMTP_HOST → 不启用，且不创建 transport', () => {
    const s = svc({});
    expect(s.enabled).toBe(false);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('配置了 SMTP_HOST → 启用并创建 transport', () => {
    const s = svc({ SMTP_HOST: 'smtp.example.com' });
    expect(s.enabled).toBe(true);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', port: 465, secure: true }),
    );
  });

  it('MAIL_ENABLED=false 可显式关闭', () => {
    expect(svc({ SMTP_HOST: 'smtp.example.com', MAIL_ENABLED: 'false' }).enabled).toBe(false);
  });

  it('SMTP_PORT=587 默认不加密，SMTP_SECURE=true 可覆盖', () => {
    svc({ SMTP_HOST: 'h', SMTP_PORT: '587' });
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ secure: false }));
    svc({ SMTP_HOST: 'h', SMTP_PORT: '587', SMTP_SECURE: 'true' });
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ secure: true }));
  });

  it('有账号时带 auth，无账号时不带（避免空凭据被服务器拒）', () => {
    svc({ SMTP_HOST: 'h', SMTP_USER: 'u@example.com', SMTP_PASS: 'p' });
    expect(createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ auth: { user: 'u@example.com', pass: 'p' } }),
    );
    svc({ SMTP_HOST: 'h' });
    expect(createTransport).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ auth: expect.anything() }),
    );
  });
});

describe('SmtpMailService 投递', () => {
  it('未配置时抛 not-configured（调用方据此返回 503）', async () => {
    await expect(svc({}).sendVerificationCode('a@b.com', MAIL)).rejects.toMatchObject({
      name: 'MailError',
      kind: 'not-configured',
    });
  });

  it('未配置 MAIL_FROM 时从 SMTP_HOST 推 no-reply 发件人', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    const s = svc({ SMTP_HOST: 'smtp.example.com' }, { sendMail });

    await s.sendVerificationCode('a@b.com', MAIL);

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'AI Gateway <no-reply@smtp.example.com>' }),
    );
  });

  it('投递成功：带 from/to/subject/text/html', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    const s = svc({ SMTP_HOST: 'h', MAIL_FROM: 'AI Gateway <no-reply@x.com>' }, { sendMail });

    await s.sendVerificationCode('a@b.com', MAIL);

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'AI Gateway <no-reply@x.com>',
        to: 'a@b.com',
        subject: expect.stringContaining('注册验证码'),
        text: expect.stringContaining('123456'),
        html: expect.stringContaining('123456'),
      }),
    );
  });

  it('SMTP 抛错 → 包装成 send-failed，不把底层错误直接抛给调用方', async () => {
    const s = svc(
      { SMTP_HOST: 'h' },
      { sendMail: jest.fn().mockRejectedValue(new Error('Connection refused')) },
    );

    await expect(s.sendVerificationCode('a@b.com', MAIL)).rejects.toBeInstanceOf(MailError);
    await expect(s.sendVerificationCode('a@b.com', MAIL)).rejects.toMatchObject({
      kind: 'send-failed',
    });
  });
});

describe('normalizeMailLocale', () => {
  it('中文族按简繁分流', () => {
    expect(normalizeMailLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeMailLocale('zh')).toBe('zh-CN');
    expect(normalizeMailLocale('zh-Hant')).toBe('zh-Hant');
    expect(normalizeMailLocale('zh-TW')).toBe('zh-Hant');
    expect(normalizeMailLocale('zh-HK')).toBe('zh-Hant');
  });

  it('英文与空值', () => {
    expect(normalizeMailLocale('en-US')).toBe('en');
    expect(normalizeMailLocale('ja')).toBe('zh-CN');
    expect(normalizeMailLocale(undefined)).toBe('zh-CN');
    expect(normalizeMailLocale('')).toBe('zh-CN');
  });
});

describe('验证码邮件模板', () => {
  it('三语文案都含验证码与有效期，且互不相同', () => {
    const rendered = (['zh-CN', 'zh-Hant', 'en'] as const).map((locale) =>
      buildVerificationMail({ ...MAIL, locale }),
    );
    for (const r of rendered) {
      expect(r.text).toContain('123456');
      expect(r.text).toContain('10');
      expect(r.html).toContain('123456');
    }
    expect(new Set(rendered.map((r) => r.subject)).size).toBe(3);
    expect(new Set(rendered.map((r) => r.text)).size).toBe(3);
  });

  it('注册与找回密码是两套主题（用户能分辨用途）', () => {
    const reg = buildVerificationMail({ ...MAIL, purpose: 'register', locale: 'en' });
    const reset = buildVerificationMail({ ...MAIL, purpose: 'reset', locale: 'en' });
    expect(reg.subject).not.toBe(reset.subject);
    expect(reg.subject).toContain('sign-up');
    expect(reset.subject).toContain('password reset');
  });

  it('安全提示在场：有效期 + 勿泄露 + 可忽略', () => {
    const zh = buildVerificationMail(MAIL);
    expect(zh.text).toContain('10 分钟内有效');
    expect(zh.text).toContain('请勿泄露');
    expect(zh.text).toContain('忽略本邮件');
  });
});
