import { jaiPaySign, jaiPayVerify } from './jai-pay.sign';

const SECRET = 'd5c0a1fc0e3b4f0d8a2c6e7f8b9a0c1d';

describe('jaiPaySign', () => {
  it('matches the documented signature for the guide example', () => {
    const params = {
      amount: '100',
      appId: '60cca0c1e2b14f0ebce123456789abcd',
      currency: 'cny',
      mchNo: 'M1234567890',
      reqTime: '20260619120000',
      signType: 'MD5',
      version: '1.0',
    };
    // 指南示例字符串：
    // amount=100&appId=...&currency=cny&mchNo=...&reqTime=...&signType=MD5&version=1.0&key=<secret>
    expect(jaiPaySign(params, SECRET)).toBe('F9A2C7AA8FEA9D4B7085B0E27BB70AE0');
  });

  it('excludes empty values and the sign field, sorts case-insensitively', () => {
    const withNoise = {
      b: '2',
      A: '1',
      note: '',
      emptyNull: null,
      emptyUndef: undefined,
      sign: 'SHOULD_BE_IGNORED',
    };
    const clean = { b: '2', A: '1' };
    expect(jaiPaySign(withNoise, SECRET)).toBe(jaiPaySign(clean, SECRET));
  });

  it('verifies signatures case-insensitively and rejects wrong ones', () => {
    const params = { mchOrderNo: 'PAY1', amount: 100, state: '2' };
    const sign = jaiPaySign(params, SECRET);
    expect(jaiPayVerify({ ...params, sign }, SECRET)).toBe(true);
    expect(jaiPayVerify({ ...params, sign: sign.toLowerCase() }, SECRET)).toBe(true);
    expect(jaiPayVerify({ ...params, sign: 'DEADBEEF' }, SECRET)).toBe(false);
    expect(jaiPayVerify({ ...params }, SECRET)).toBe(false);
    expect(jaiPayVerify({ ...params, sign }, 'other-secret')).toBe(false);
  });
});
