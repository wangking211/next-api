const API = 'http://localhost:3000';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  -> ${JSON.stringify(extra)}`); }
}
async function api(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const chat = (sk, body) => fetch(API + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sk}` },
  body: JSON.stringify(body),
});

const suffix = Date.now().toString().slice(-6);
const pmodel = `p7plat-${suffix}`;
const bmodel = `p7byok-${suffix}`;

// setup
const reg = await api('POST', '/api/auth/register', { body: { email: `b7${suffix}@t.com`, username: `b7${suffix}`, password: 'password123' } });
const jwt = reg.data.accessToken;
const uid = reg.data.user.id;
const admin = await api('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'admin123456' } });
const adminJwt = admin.data.accessToken;

// pricing + channels
await api('POST', '/api/models', { token: adminJwt, body: { name: pmodel, displayName: pmodel, provider: 'openai', inputPrice: 1.0, outputPrice: 2.0 } });
await api('POST', '/api/models', { token: adminJwt, body: { name: bmodel, displayName: bmodel, provider: 'openai', inputPrice: 1.0, outputPrice: 2.0 } });
const platformCh = await api('POST', '/api/channels', { token: adminJwt, body: { name: 'plat', provider: 'openai', baseUrl: 'http://localhost:4001/good/v1', apiKey: 'x', models: [pmodel], ownerType: 'PLATFORM' } });
check('admin creates platform channel', platformCh.status === 201 && platformCh.data.ownerType === 'PLATFORM', platformCh.data);
await api('POST', '/api/channels', { token: jwt, body: { name: 'byok', provider: 'openai', baseUrl: 'http://localhost:4001/good/v1', apiKey: 'y', models: [bmodel] } });
const keyRes = await api('POST', '/api/keys', { token: jwt, body: { name: 'B' } });
const sk = keyRes.data.plaintext;

// 初始余额 0
const bal0 = await api('GET', '/api/billing/me', { token: jwt });
check('initial balance 0', bal0.data.balance === 0, bal0.data);

// 余额为 0 时，平台渠道调用被拦截
const blocked = await chat(sk, { model: pmodel, messages: [{ role: 'user', content: 'hi' }] });
check('zero balance blocks platform call -> 403', blocked.status === 403, blocked.status);
const blockedBody = await blocked.json();
check('insufficient balance code', blockedBody?.error?.code === 'insufficient_balance', blockedBody);

// 管理员充值 $1
const recharge = await api('POST', `/api/admin/users/${uid}/recharge`, { token: adminJwt, body: { amount: 1, description: 'test topup' } });
check('admin recharge ok', recharge.status === 201 && recharge.data.type === 'RECHARGE', recharge.data);
const bal1 = await api('GET', '/api/billing/me', { token: jwt });
check('balance after recharge = 1', Math.abs(bal1.data.balance - 1) < 1e-9, bal1.data);

// 平台渠道调用按成本扣费 (mock: prompt11 completion7 -> 0.000011 + 0.000014 = 0.000025)
const r1 = await chat(sk, { model: pmodel, messages: [{ role: 'user', content: 'hi' }] });
check('platform call 200', r1.status === 200, r1.status);
const bal2 = await api('GET', '/api/billing/me', { token: jwt });
check('balance deducted by cost', Math.abs(bal2.data.balance - 0.999975) < 1e-9, bal2.data);
// 平台渠道调用会累计 Key 费用额度（与余额扣款同口径）
const keysAfterPlatform = await api('GET', '/api/keys', { token: jwt });
const keyAfterPlatform = keysAfterPlatform.data.find((k) => k.id === keyRes.data.id);
check(
  'key costUsed accumulates for platform',
  Math.abs(Number(keyAfterPlatform.costUsed) - 0.000025) < 1e-9,
  keyAfterPlatform.costUsed,
);

// 账单明细
const txs = await api('GET', '/api/billing/transactions', { token: jwt });
const types = txs.data.items.map((t) => t.type);
check('transactions include RECHARGE & CONSUME', types.includes('RECHARGE') && types.includes('CONSUME'), types);
check('consume amount negative', Number(txs.data.items.find((t) => t.type === 'CONSUME').amount) < 0, txs.data.items[0]);

// BYOK 渠道调用不扣费
const r2 = await chat(sk, { model: bmodel, messages: [{ role: 'user', content: 'hi' }] });
check('byok call 200', r2.status === 200, r2.status);
const bal3 = await api('GET', '/api/billing/me', { token: jwt });
check('byok call does not deduct balance', Math.abs(bal3.data.balance - bal2.data.balance) < 1e-9, bal3.data);
// BYOK 调用不得消耗 Key 费用额度（否则 costLimit 会被免费调用吃满）
const keysAfterByok = await api('GET', '/api/keys', { token: jwt });
const keyAfterByok = keysAfterByok.data.find((k) => k.id === keyRes.data.id);
check(
  'byok call does not consume costUsed',
  Math.abs(Number(keyAfterByok.costUsed) - Number(keyAfterPlatform.costUsed)) < 1e-9,
  keyAfterByok.costUsed,
);

// 管理员调整余额到 0，再次拦截
await api('POST', `/api/admin/users/${uid}/adjust`, { token: adminJwt, body: { amount: -(bal3.data.balance), description: 'reset' } });
const bal4 = await api('GET', '/api/billing/me', { token: jwt });
check('balance reset to 0', Math.abs(bal4.data.balance) < 1e-9, bal4.data);
const blocked2 = await chat(sk, { model: pmodel, messages: [{ role: 'user', content: 'hi' }] });
check('platform blocked again after reset', blocked2.status === 403, blocked2.status);

// 权限
const forbid = await api('GET', '/api/admin/users', { token: jwt });
check('non-admin cannot list users -> 403', forbid.status === 403, forbid.status);
const adminList = await api('GET', '/api/admin/users?q=' + `b7${suffix}`, { token: adminJwt });
check('admin lists users', adminList.status === 200 && adminList.data.total >= 1, adminList.data.total);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
