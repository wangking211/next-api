import type { MailLocale, MailPurpose, VerificationMail } from './mail.service';

const BRAND = 'AI Gateway';

/** 主题行（各语言共用品牌前缀，便于用户在收件箱里一眼识别） */
function subject(purpose: MailPurpose, locale: MailLocale): string {
  if (purpose === 'register') {
    if (locale === 'en') return `[${BRAND}] Your sign-up verification code`;
    if (locale === 'zh-Hant') return `【${BRAND}】註冊驗證碼`;
    return `【${BRAND}】注册验证码`;
  }
  if (locale === 'en') return `[${BRAND}] Your password reset code`;
  if (locale === 'zh-Hant') return `【${BRAND}】找回密碼驗證碼`;
  return `【${BRAND}】找回密码验证码`;
}

/** 纯文本正文（不依赖 HTML 渲染的邮件客户端也能读） */
function text(
  code: string,
  purpose: MailPurpose,
  locale: MailLocale,
  ttlMinutes: number,
): string {
  if (locale === 'en') {
    const lead =
      purpose === 'register'
        ? 'Use the code below to verify your email address when signing up:'
        : 'Use the code below to reset your account password:';
    return [
      'Hi,',
      '',
      lead,
      '',
      `    ${code}`,
      '',
      `The code is valid for ${ttlMinutes} minutes and can only be used once. Never share it with anyone.`,
      'If you did not request this, you can safely ignore this email.',
      '',
      `— ${BRAND}`,
    ].join('\n');
  }

  const zh = locale === 'zh-Hant';
  const lead =
    purpose === 'register'
      ? zh
        ? '你正在註冊 AI Gateway 帳號，請使用下方驗證碼完成郵箱驗證：'
        : '你正在注册 AI Gateway 账号，请使用下方验证码完成邮箱验证：'
      : zh
        ? '你正在找回 AI Gateway 帳號密碼，請使用下方驗證碼繼續：'
        : '你正在找回 AI Gateway 账号密码，请使用下方验证码继续：';
  return [
    '你好，',
    '',
    lead,
    '',
    `    ${code}`,
    '',
    zh
      ? `驗證碼 ${ttlMinutes} 分鐘內有效且僅可使用一次，請勿泄露給他人。`
      : `验证码 ${ttlMinutes} 分钟内有效且仅可使用一次，请勿泄露给他人。`,
    zh ? '如果這不是你本人的操作，請忽略本郵件。' : '如果这不是你本人的操作，请忽略本邮件。',
    '',
    `—— ${BRAND}`,
  ].join('\n');
}

/** HTML 正文：大号验证码 + 有效期与安全提示 */
function html(
  code: string,
  purpose: MailPurpose,
  locale: MailLocale,
  ttlMinutes: number,
): string {
  const en = locale === 'en';
  const zh = locale === 'zh-Hant';
  const title = en
    ? purpose === 'register'
      ? 'Verify your email'
      : 'Reset your password'
    : purpose === 'register'
      ? zh
        ? '驗證你的郵箱'
        : '验证你的邮箱'
      : zh
        ? '找回密碼'
        : '找回密码';
  const hint = en
    ? purpose === 'register'
      ? 'Enter this code to finish signing up.'
      : 'Enter this code to continue resetting your password.'
    : purpose === 'register'
      ? zh
        ? '輸入該碼以完成註冊。'
        : '输入该码以完成注册。'
      : zh
        ? '輸入該碼以繼續找回密碼。'
        : '输入该码以继续找回密码。';
  const valid = en
    ? `Valid for ${ttlMinutes} minutes · single use`
    : zh
      ? `${ttlMinutes} 分鐘內有效 · 僅可使用一次`
      : `${ttlMinutes} 分钟内有效 · 仅可使用一次`;
  const ignore = en
    ? 'Did not request this? You can safely ignore this email.'
    : zh
      ? '若非本人操作，請忽略本郵件即可。'
      : '若非本人操作，忽略本邮件即可。';

  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f5f6f8;padding:32px 16px">',
    '  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px 28px;border:1px solid #e8e8e8">',
    `    <div style="font-size:13px;letter-spacing:.08em;color:#8c8c8c;text-transform:uppercase">${BRAND}</div>`,
    `    <h1 style="font-size:20px;margin:8px 0 16px;color:#141414">${title}</h1>`,
    `    <p style="font-size:14px;color:#595959;margin:0 0 20px">${hint}</p>`,
    `    <div style="font-size:34px;font-weight:700;letter-spacing:.22em;color:#1677ff;background:#f0f5ff;border:1px dashed #94bfff;border-radius:8px;padding:16px 0;text-align:center">${code}</div>`,
    `    <p style="font-size:12px;color:#8c8c8c;margin:16px 0 0">${valid}</p>`,
    `    <p style="font-size:12px;color:#8c8c8c;margin:8px 0 0">${ignore}</p>`,
    '  </div>',
    '</div>',
  ].join('\n');
}

export function buildVerificationMail(mail: VerificationMail): {
  subject: string;
  text: string;
  html: string;
} {
  const { code, purpose, locale, ttlMinutes } = mail;
  return {
    subject: subject(purpose, locale),
    text: text(code, purpose, locale, ttlMinutes),
    html: html(code, purpose, locale, ttlMinutes),
  };
}
