import { redactSecrets } from './redact.util';

describe('redactSecrets（上游错误文案里的凭据脱敏）', () => {
  it('masks OpenAI-style keys（实测上游会回显渠道密钥）', () => {
    const raw = 'token 无效：sk-e280214426a3926f9da9b1101da475c7419cabd0659c1b0a61f251362f10a0fe';
    const out = redactSecrets(raw);
    expect(out).not.toContain('sk-e280214426a3926f9da9b1101da475c7419cabd0659c1b0a61f251362f10a0fe');
    expect(out).toContain('sk-***');
    // 非密钥部分保持可见，便于排查
    expect(out).toContain('token 无效');
  });

  it('masks sk_ 前缀与 Bearer 凭据', () => {
    expect(redactSecrets('key=sk_live_abcDEF123456')).toContain('sk_***');
    expect(redactSecrets('Authorization: Bearer abcdef123456')).toContain('Bearer ***');
    expect(redactSecrets('Authorization: Bearer abcdef123456')).not.toContain('abcdef123456');
  });

  it('masks key=value 形态的 api_key / secret / password', () => {
    expect(redactSecrets('api_key=supersecret01')).toContain('api_key=***');
    expect(redactSecrets('api_key=supersecret01')).not.toContain('supersecret01');
    expect(redactSecrets('password:"hunter2hunter2"')).not.toContain('hunter2hunter2');
    expect(redactSecrets('password:"hunter2hunter2"')).toContain('***');
  });

  it('masks long hex blobs (>=40)', () => {
    const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef';
    expect(redactSecrets(`sig=${hex}`)).not.toContain(hex);
    expect(redactSecrets(`sig=${hex}`)).toContain('***');
  });

  it('leaves normal error text untouched', () => {
    const msg = 'upstream 429: rate limit exceeded';
    expect(redactSecrets(msg)).toBe(msg);
  });

  it('handles non-string input safely', () => {
    expect(redactSecrets(null)).toBe('');
    expect(redactSecrets(undefined)).toBe('');
    expect(redactSecrets(404)).toBe('404');
  });
});
