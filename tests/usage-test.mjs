import { api, check, chat, finish, until } from './helpers.mjs';

const summary = () => api('GET', '/api/usage/summary', { token: jwt });

const suffix = Date.now().toString().slice(-6);
const model = `p4model-${suffix}`;

const reg = await api('POST', '/api/auth/register', {
  body: { email: `p4${suffix}@t.com`, username: `p4${suffix}`, password: 'password123' },
});
const jwt = reg.data.accessToken;
const admin = await api('POST', '/api/auth/login', {
  body: { identifier: 'admin', password: 'admin123456' },
});
const adminJwt = admin.data.accessToken;

await api('POST', '/api/models', {
  token: adminJwt,
  body: { name: model, displayName: model, provider: 'openai', inputPrice: 1.0, outputPrice: 2.0 },
});
await api('POST', '/api/channels', {
  token: jwt,
  body: {
    name: 'good',
    provider: 'openai',
    baseUrl: 'http://localhost:4001/good/v1',
    apiKey: 'x',
    models: [model],
  },
});
await api('POST', '/api/channels', {
  token: jwt,
  body: {
    name: 'bad',
    provider: 'openai',
    baseUrl: 'http://localhost:4001/bad/v1',
    apiKey: 'x',
    models: [model],
    priority: 100,
  },
});

// ---- key A: 无限额 ----
const keyA = await api('POST', '/api/keys', { token: jwt, body: { name: 'A' } });
const skA = keyA.data.plaintext;

// 非流式（mock: prompt=11, completion=7, total=18）
const r1 = await chat(skA, { model, messages: [{ role: 'user', content: 'hi' }] });
check('non-stream ok', r1.status === 200, r1.status);

// 落账后台完成 → 轮询等到第 1 笔落地，再读 key 用量与 summary
await until(async () => (await summary()).data.requests >= 1);

// key 用量累计
const keys1 = await api('GET', '/api/keys', { token: jwt });
const kA = keys1.data.find((k) => k.id === keyA.data.id);
check('key quotaUsed = 18', kA.quotaUsed === 18, kA.quotaUsed);
// BYOK（用户自有）渠道不实际扣费，因此 Key 的费用额度不累计；
// 折算金额仍记录在 summary/logs（见下方断言），平台渠道才累计 costUsed（见 billing-test.mjs）
check('key costUsed stays 0 for BYOK', Number(kA.costUsed) === 0, kA.costUsed);

// summary
const sum1 = await api('GET', '/api/usage/summary', { token: jwt });
check('summary requests >= 1', sum1.data.requests >= 1, sum1.data.requests);
check('summary totalTokens = 18', sum1.data.totalTokens === 18, sum1.data.totalTokens);
check(
  'summary cost = 0.000025',
  Math.abs(Number(sum1.data.cost) - 0.000025) < 1e-9,
  sum1.data.cost,
);

// 流式（mock 无 usage -> 估算 content="Hello from mock" 15字符 => 4 tokens, prompt=2 字符/4=1）
const r2 = await chat(skA, { model, stream: true, messages: [{ role: 'user', content: 'hi' }] });
const s2 = await r2.text();
check('stream ok', r2.status === 200 && s2.includes('[DONE]'), r2.status);

await until(async () => (await summary()).data.requests >= 2);
const sum2 = await api('GET', '/api/usage/summary', { token: jwt });
check('summary requests >= 2', sum2.data.requests >= 2, sum2.data.requests);
check('stream tokens recorded', sum2.data.totalTokens > 18, sum2.data.totalTokens);

// logs & daily
const logs = await api('GET', '/api/usage/logs?page=1&pageSize=10', { token: jwt });
check('logs returns items', logs.data.total >= 2 && logs.data.items.length >= 2, logs.data.total);
check(
  'logs contains model & channel',
  logs.data.items[0].model === model && !!logs.data.items[0].channel,
  logs.data.items[0],
);

// 日志详情包含输入/输出内容
const okLog = logs.data.items.find((i) => i.status < 400) ?? logs.data.items[0];
const detail = await api('GET', `/api/usage/logs/${okLog.id}`, { token: jwt });
check(
  'log detail has input/output content',
  detail.status === 200 &&
    typeof detail.data.requestPreview === 'string' &&
    detail.data.requestPreview.includes('hi') &&
    typeof detail.data.responsePreview === 'string' &&
    detail.data.responsePreview.includes('Hello from mock'),
  { req: detail.data.requestPreview, resp: detail.data.responsePreview },
);
const daily = await api('GET', '/api/usage/daily?days=7', { token: jwt });
check(
  'daily aggregate has row',
  daily.data.length >= 1 && daily.data.at(-1).requests >= 2,
  daily.data,
);

// 日志过滤与聚合
const byModel = await api('GET', `/api/usage/logs?model=${model}&pageSize=50`, { token: jwt });
check(
  'log filter by model',
  byModel.status === 200 &&
    byModel.data.total >= 2 &&
    byModel.data.items.every((i) => i.model === model),
  byModel.data.total,
);
const successOnly = await api('GET', '/api/usage/logs?status=success&pageSize=50', { token: jwt });
check(
  'log filter success only',
  successOnly.status === 200 && successOnly.data.items.every((i) => i.status < 400),
  successOnly.data.items.map((i) => i.status),
);
const kw = await api(
  'GET',
  `/api/usage/logs?q=${encodeURIComponent('Hello from mock')}&pageSize=50`,
  { token: jwt },
);
check('log keyword search', kw.status === 200 && kw.data.total >= 1, kw.data.total);
const analytics = await api('GET', '/api/usage/analytics?days=30', { token: jwt });
check(
  'analytics aggregates by model',
  analytics.status === 200 &&
    analytics.data.totals.requests >= 2 &&
    analytics.data.byModel.some((m) => m.model === model),
  analytics.data.totals,
);

// ---- key B: 限流 rpm=2 ----
const keyB = await api('POST', '/api/keys', { token: jwt, body: { name: 'B', rpmLimit: 2 } });
const skB = keyB.data.plaintext;
const st = [];
for (let i = 0; i < 3; i++)
  st.push((await chat(skB, { model, messages: [{ role: 'user', content: 'hi' }] })).status);
check('rate limit: first two 200', st[0] === 200 && st[1] === 200, st);
check('rate limit: third 429', st[2] === 429, st);

// ---- key C: 额度 quota=18 ----
const keyC = await api('POST', '/api/keys', { token: jwt, body: { name: 'C', quotaLimit: 18 } });
const skC = keyC.data.plaintext;
const c1 = await chat(skC, { model, messages: [{ role: 'user', content: 'hi' }] });
check('quota key first request 200', c1.status === 200, c1.status);
// 等第 1 次调用的用量落到账上再发第 2 次：预检读的是 quotaUsed，抢跑会误放行成 200
await until(async () => {
  const ks = await api('GET', '/api/keys', { token: jwt });
  return (ks.data.find((k) => k.id === keyC.data.id)?.quotaUsed ?? 0) >= 18;
});
const c2 = await chat(skC, { model, messages: [{ role: 'user', content: 'hi' }] });
check('quota key second request 403 (exhausted)', c2.status === 403, c2.status);
const c2body = await c2.json();
// 网关错误统一为 OpenAI 形状 {error:{message,type,code}}（GatewayErrorFilter）
check(
  'quota error message',
  /quota/i.test(c2body?.error?.message ?? c2body?.message ?? '') &&
    c2body?.error?.type === 'permission_error',
  c2body,
);

// admin 全局视图（等 5 笔落账全部完成：r1/流式/B×2/C1）
await until(
  async () =>
    (await api('GET', '/api/usage/summary?scope=all', { token: adminJwt })).data.requests >= 5,
);
const adminSum = await api('GET', '/api/usage/summary?scope=all', { token: adminJwt });
check('admin scope=all works', adminSum.data.requests >= 5, adminSum.data.requests);
const userAllView = await api('GET', '/api/usage/summary?scope=all', { token: jwt });
check(
  'non-admin scope=all restricted to own',
  userAllView.data.requests >= 4,
  userAllView.data.requests,
);

finish();
