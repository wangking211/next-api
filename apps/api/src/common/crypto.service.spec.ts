import { CryptoService } from './crypto.service';
import { ConfigService } from '@nestjs/config';

function makeService(overrides: Record<string, string> = {}): CryptoService {
  const values: Record<string, string> = {
    ENCRYPTION_KEY: 'a'.repeat(64),
    API_KEY_PREFIX: 'sk-',
    ...overrides,
  };
  const config = { get: (k: string, d?: string) => values[k] ?? d } as ConfigService;
  return new CryptoService(config);
}

describe('CryptoService', () => {
  it('round-trips encrypted secrets', () => {
    const svc = makeService();
    const secret = 'sk-upstream-secret-1234';
    const enc = svc.encrypt(secret);
    expect(enc).not.toContain(secret);
    expect(svc.decrypt(enc)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const svc = makeService();
    expect(svc.encrypt('same')).not.toBe(svc.encrypt('same'));
  });

  it('rejects tampered ciphertext', () => {
    const svc = makeService();
    const enc = svc.encrypt('secret');
    const parts = enc.split('.');
    parts[2] = Buffer.from('tampered').toString('base64');
    expect(() => svc.decrypt(parts.join('.'))).toThrow();
  });

  it('generates platform keys with prefix and stable hash', () => {
    const svc = makeService();
    const { plaintext, hash, prefix } = svc.generateApiKey();
    expect(plaintext.startsWith('sk-')).toBe(true);
    expect(hash).toBe(svc.hashApiKey(plaintext));
    expect(prefix.startsWith('sk-')).toBe(true);
    expect(plaintext.startsWith(prefix)).toBe(true);
  });

  it('throws on invalid encryption key', () => {
    expect(() => makeService({ ENCRYPTION_KEY: 'short' })).toThrow(/32 bytes hex/);
  });
});
