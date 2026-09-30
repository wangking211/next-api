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
  let data = null; try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}
const chat = (sk, body) => fetch(API + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sk}` },
  body: JSON.stringify(body),
});

const suffix = Date.now().toString().slice(-6);
const model = `ops-${suffix}`;

const reg = await api('POST', '/api/auth/register', { body: { email: `ops${suffix}@t.com`, username: `ops${suffix}`, password: 'password123' } });
const jwt = reg.data.accessToken;
const admin = await api('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'admin123456' } });
const adminJwt = admin.data.accessToken;

// bad 渠道（优先级高，先被尝试，返回 500）+ good 渠道兜底
await api('POST', '/api/channels', { token: jwt, body: { name: 'ops-bad', provider: 'openai', baseUrl: 'http://localhost:4001/bad/v1', apiKey: 'x', models: [model], priority: 100 } });
await api('POST', '/api/channels', { token: jwt, body: { name: 'ops-good', provider: 'openai', baseUrl: 'http://localhost:4001/good/v1', apiKey: 'y', models: [model], priority: 1 } });
const keyRes = await api('POST', '/api/keys', { token: jwt, body: { name: 'ops' } });
const sk = keyRes.data.plaintext;

// CHANNEL_FAILURE_THRESHOLD=3：连续 3 次失败后自动禁用（故障转移仍成功）
const codes = [];
for (let i = 0; i < 3; i++) {
  const r = await chat(sk, { model, messages: [{ role: 'user', content: 'hi' }] });
  codes.push(r.status);
}
check('requests succeed via failover', codes.every((c) => c === 200), codes);

const chList = await api('GET', '/api/channels?pageSize=100', { token: jwt });
const bad = chList.data.items.find((c) => c.name === 'ops-bad');
check('bad channel auto-disabled', bad?.status === 'DISABLED' && bad?.autoDisabled === true, bad && { status: bad.status, autoDisabled: bad.autoDisabled, failureCount: bad.failureCount });
check('failure count recorded', bad?.failureCount >= 3, bad?.failureCount);

// 自动禁用后仍可正常服务（走 good）
const after = await chat(sk, { model, messages: [{ role: 'user', content: 'hi' }] });
check('still served after auto-disable', after.status === 200, after.status);

// 重新启用 → 计数清零、autoDisabled 复位
const reenable = await api('PATCH', `/api/channels/${bad.id}`, { token: jwt, body: { status: 'ENABLED' } });
check('re-enable resets health', reenable.status === 200 && reenable.data.status === 'ENABLED' && reenable.data.autoDisabled === false && reenable.data.failureCount === 0, reenable.data);

// 审计日志：写操作被记录
const audit = await api('GET', '/api/admin/audit-logs?pageSize=100', { token: adminJwt });
check('audit logs recorded', audit.status === 200 && audit.data.total > 0, audit.data.total);
const actions = audit.data.items.map((a) => a.action);
check('audit contains channel creates', actions.includes('POST channels'), actions.slice(0, 10));
check('audit contains channel patch', actions.some((a) => a.startsWith('PATCH channels')), actions.slice(0, 10));
check('audit actor recorded', audit.data.items.some((a) => a.actorName === `ops${suffix}`), audit.data.items[0]);
const failedAudit = audit.data.items.find((a) => a.statusCode >= 400);
check('audit records failed actions too', !!failedAudit, undefined);

// 权限
const forbid = await api('GET', '/api/admin/audit-logs', { token: jwt });
check('non-admin cannot read audit -> 403', forbid.status === 403, forbid.status);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
