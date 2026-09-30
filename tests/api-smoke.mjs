const BASE = 'http://localhost:3000/api';
let pass = 0;
let fail = 0;

async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* ignore */ }
  return { status: res.status, data };
}

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}  -> ${JSON.stringify(extra)}`);
  }
}

const suffix = Date.now().toString().slice(-6);

const health = await req('GET', '/health');
check('health ok', health.status === 200 && health.data.db === 'up' && health.data.redis === 'up', health.data);

const reg = await req('POST', '/auth/register', {
  body: { email: `alice${suffix}@test.com`, username: `alice${suffix}`, password: 'password123' },
});
check('register', reg.status === 201 && !!reg.data.accessToken, reg.data);
const userToken = reg.data?.accessToken;

const me = await req('GET', '/auth/me', { token: userToken });
check('me', me.status === 200 && me.data.username === `alice${suffix}`, me.data);

const dupe = await req('POST', '/auth/register', {
  body: { email: `alice${suffix}@test.com`, username: `bob${suffix}`, password: 'password123' },
});
check('duplicate email rejected', dupe.status === 409, dupe.data);

const badLogin = await req('POST', '/auth/login', { body: { identifier: `alice${suffix}`, password: 'wrong' } });
check('bad login rejected', badLogin.status === 401, badLogin.data);

const keyCreate = await req('POST', '/keys', {
  token: userToken,
  body: { name: 'my-key', quotaLimit: 100000, costLimit: 5.5 },
});
check('create key returns plaintext once', keyCreate.status === 201 && keyCreate.data.plaintext?.startsWith('sk-'), keyCreate.data);

const keyList = await req('GET', '/keys', { token: userToken });
check('list keys hides hash', keyList.status === 200 && keyList.data.length === 1 && keyList.data[0].plaintext === undefined, keyList.data);

const keyId = keyCreate.data?.id;
const keyPatch = await req('PATCH', `/keys/${keyId}`, { token: userToken, body: { status: 'DISABLED' } });
check('update key status', keyPatch.status === 200 && keyPatch.data.status === 'DISABLED', keyPatch.data);

const noAuth = await req('GET', '/keys');
check('unauthorized rejected', noAuth.status === 401, noAuth.data);

const chCreate = await req('POST', '/channels', {
  token: userToken,
  body: { name: 'my-openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'upstream-secret-1234', models: ['gpt-4o-mini'] },
});
check('create byok channel', chCreate.status === 201 && chCreate.data.ownerType === 'USER' && !chCreate.data.apiKeyEnc, chCreate.data);
check('channel key masked', chCreate.data?.apiKeyPreview === '****1234', chCreate.data);

const chList = await req('GET', '/channels', { token: userToken });
check('list channels (paginated)', chList.status === 200 && chList.data.items.length === 1 && chList.data.total === 1, chList.data);

// 分页 + 过滤
const chFiltered = await req('GET', '/channels?name=my-openai&provider=openai&status=ENABLED&page=1&pageSize=10', { token: userToken });
check('channel filter by name/provider/status', chFiltered.status === 200 && chFiltered.data.total === 1, chFiltered.data);
const chNoMatch = await req('GET', '/channels?name=does-not-exist-xyz', { token: userToken });
check('channel filter no match', chNoMatch.status === 200 && chNoMatch.data.total === 0, chNoMatch.data);
const chByModel = await req('GET', '/channels?model=gpt-4o-mini', { token: userToken });
check('channel filter by model', chByModel.status === 200 && chByModel.data.total === 1, chByModel.data);

const avail = await req('GET', '/channels/available-models', { token: userToken });
check('available models grouped by channel', avail.status === 200 && avail.data.models.includes('gpt-4o-mini') && avail.data.channels.length >= 1, avail.data);

const platformForbidden = await req('POST', '/channels', {
  token: userToken,
  body: { name: 'hack', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'x', models: ['gpt-4o'], ownerType: 'PLATFORM' },
});
check('non-admin cannot create platform channel', platformForbidden.status === 403, platformForbidden.data);

const adminLogin = await req('POST', '/auth/login', { body: { identifier: 'admin', password: 'admin123456' } });
check('admin login', adminLogin.status === 201 && adminLogin.data.user.role === 'ADMIN', adminLogin.data);
const adminToken = adminLogin.data?.accessToken;

const modelCreate = await req('POST', '/models', {
  token: adminToken,
  body: { name: `smoke-model-${suffix}`, displayName: 'Smoke Model', provider: 'openai', inputPrice: 0.15, outputPrice: 0.6 },
});
check('admin create model', modelCreate.status === 201, modelCreate.data);

const modelForbidden = await req('POST', '/models', {
  token: userToken,
  body: { name: 'x', displayName: 'x', provider: 'openai' },
});
check('non-admin cannot create model', modelForbidden.status === 403, modelForbidden.data);

const modelList = await req('GET', '/models', { token: userToken });
check('list models', modelList.status === 200 && modelList.data.length >= 1, modelList.data);

const sugg = await req('GET', '/models/suggestions', { token: userToken });
check(
  'model suggestions available',
  sugg.status === 200 && sugg.data.length >= 20 && sugg.data.some((m) => m.name === 'gpt-5'),
  { count: sugg.data?.length },
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
