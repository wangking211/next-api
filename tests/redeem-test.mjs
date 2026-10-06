import { api, check, finish } from './helpers.mjs';

const suffix = Date.now().toString().slice(-6);
const reg = await api('POST', '/api/auth/register', {
  body: { email: `rc${suffix}@t.com`, username: `rc${suffix}`, password: 'password123' },
});
const jwt = reg.data.accessToken;
const admin = await api('POST', '/api/auth/login', {
  body: { identifier: 'admin', password: 'admin123456' },
});
const adminJwt = admin.data.accessToken;

// 非管理员不能生成
const forbid = await api('POST', '/api/admin/redeem-codes', {
  token: jwt,
  body: { amount: 1, quantity: 1 },
});
check('non-admin cannot generate -> 403', forbid.status === 403, forbid.status);

// 管理员生成 3 个 $2 兑换码
const gen = await api('POST', '/api/admin/redeem-codes', {
  token: adminJwt,
  body: { amount: 2, quantity: 3, note: `batch-${suffix}` },
});
check('admin generates codes', gen.status === 201 && gen.data.codes?.length === 3, gen.data);
check(
  'codes formatted',
  /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(gen.data.codes[0]),
  gen.data.codes[0],
);
const [c1, c2, c3] = gen.data.codes;

// 非法兑换码
const bad = await api('POST', '/api/billing/redeem', {
  token: jwt,
  body: { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' },
});
check('invalid code -> 400', bad.status === 400, bad.status);

// 兑换成功（大小写不敏感）
const r1 = await api('POST', '/api/billing/redeem', {
  token: jwt,
  body: { code: c1.toLowerCase() },
});
check('redeem ok', r1.status === 201 && Math.abs(r1.data.balance - 2) < 1e-9, r1.data);
const bal1 = await api('GET', '/api/billing/me', { token: jwt });
check('balance after redeem = 2', Math.abs(bal1.data.balance - 2) < 1e-9, bal1.data);

// 重复兑换同一码
const r1again = await api('POST', '/api/billing/redeem', { token: jwt, body: { code: c1 } });
check('re-redeem same code -> 400', r1again.status === 400, r1again.data);
const bal1b = await api('GET', '/api/billing/me', { token: jwt });
check('balance unchanged after failed redeem', Math.abs(bal1b.data.balance - 2) < 1e-9, bal1b.data);

// 再次兑换另一码
const r2 = await api('POST', '/api/billing/redeem', { token: jwt, body: { code: c2 } });
check('second redeem ok', r2.status === 201 && Math.abs(r2.data.balance - 4) < 1e-9, r2.data);

// 作废后不可兑换
const list = await api('GET', '/api/admin/redeem-codes?status=UNUSED&pageSize=50', {
  token: adminJwt,
});
const target = list.data.items.find((c) => c.code === c3);
check('admin lists unused codes', !!target, list.data.total);
const dis = await api('PATCH', `/api/admin/redeem-codes/${target.id}/disable`, { token: adminJwt });
check('disable code', dis.status === 200 && dis.data.status === 'DISABLED', dis.data);
const r3 = await api('POST', '/api/billing/redeem', { token: jwt, body: { code: c3 } });
check('disabled code -> 400', r3.status === 400, r3.data);

// 账单中出现兑换充值
const txs = await api('GET', '/api/billing/transactions?type=RECHARGE', { token: jwt });
check(
  'redeem appears as RECHARGE tx',
  txs.data.items.some((t) => /兑换码/.test(t.description ?? '')),
  txs.data.items.length,
);

finish();
