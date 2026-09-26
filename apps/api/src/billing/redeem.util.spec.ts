import { generateRedeemCode, normalizeCode } from './redeem.util';

describe('redeem.util', () => {
  it('generates grouped codes in expected format', () => {
    const code = generateRedeemCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('avoids ambiguous characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateRedeemCode()).not.toMatch(/[O0I1]/);
    }
  });

  it('generates distinct codes', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateRedeemCode()));
    expect(set.size).toBe(200);
  });

  it('normalizes codes (trim + uppercase)', () => {
    expect(normalizeCode('  abcd-efgh  ')).toBe('ABCD-EFGH');
  });
});
