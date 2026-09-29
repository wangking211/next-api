import {
  assertProdJwtSecret,
  resolveJwtSecret,
  MIN_PROD_JWT_SECRET_LENGTH,
} from './jwt-secret';

const STRONG = 'seed-9F2kQ7xWm4Tz8LpR1vB6nH3jC5yD0a';

describe('assertProdJwtSecret', () => {
  it('rejects placeholders and empty values', () => {
    expect(() => assertProdJwtSecret('change-me')).toThrow(/不安全/);
    expect(() => assertProdJwtSecret('change-me-in-production')).toThrow(/不安全/);
    expect(() => assertProdJwtSecret('')).toThrow(/不安全/);
    expect(() => assertProdJwtSecret(undefined as any)).toThrow(/不安全/);
  });

  it('rejects short secrets', () => {
    expect(() => assertProdJwtSecret('short')).toThrow(
      new RegExp(`${MIN_PROD_JWT_SECRET_LENGTH}`),
    );
    expect(() => assertProdJwtSecret('a'.repeat(MIN_PROD_JWT_SECRET_LENGTH - 1))).toThrow(
      /长度/,
    );
  });

  it('rejects low-entropy repeated-character secrets', () => {
    expect(() => assertProdJwtSecret('a'.repeat(64))).toThrow(/熵/);
  });

  it('accepts a strong secret', () => {
    expect(() => assertProdJwtSecret(STRONG)).not.toThrow();
    expect(() => assertProdJwtSecret(`  ${STRONG}  `)).not.toThrow();
  });
});

describe('resolveJwtSecret', () => {
  it('fails fast in production when the secret is insecure', () => {
    expect(() => resolveJwtSecret('change-me', true)).toThrow(/不安全/);
    expect(() => resolveJwtSecret(undefined, true)).toThrow(/不安全/);
  });

  it('returns the configured secret in production', () => {
    expect(resolveJwtSecret(STRONG, true)).toBe(STRONG);
  });

  it('generates a per-boot random secret outside production when missing or placeholder', () => {
    const a = resolveJwtSecret(undefined, false);
    const b = resolveJwtSecret('change-me', false);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('keeps a configured non-placeholder secret outside production', () => {
    expect(resolveJwtSecret('my-dev-secret-at-least-16', false)).toBe(
      'my-dev-secret-at-least-16',
    );
  });
});
