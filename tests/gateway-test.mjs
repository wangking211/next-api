const API = 'http://localhost:3000';
let pass = 0;
let fail = 0;
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
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
async function collectStream(path, key, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return { status: res.status, text };
}

const suffix = Date.now().toString().slice(-6);
const reg = await api('POST', '/api/auth/register', {
  body: { email: `gw${suffix}@test.com`, username: `gw${suffix}`, password: 'password123' },
});
const jwt = reg.data.accessToken;
const keyRes = await api('POST', '/api/keys', { token: jwt, body: { name: 'gw-key' } });
const sk = keyRes.data.plaintext;
check('setup: got platform key', !!sk && sk.startsWith('sk-'), keyRes.data);

const mk = (name, provider, baseUrl, models, priority) =>
  api('POST', '/api/channels', {
    token: jwt,
    body: { name, provider, baseUrl, apiKey: 'upstream-secret', models, priority },
  });

const chGood = await mk('good-openai', 'openai', 'http://localhost:4001/good/v1', ['gpt-test'], 1);
const chBad = await mk('bad-openai', 'openai', 'http://localhost:4001/bad/v1', ['gpt-test'], 100);
await mk('good-anthropic', 'anthropic', 'http://localhost:4001/good/v1', ['claude-test'], 1);
await mk('good-gemini', 'gemini', 'http://localhost:4001/good/v1beta', ['gemini-test'], 1);

// 渠道连通性测试（批量）
const tGood = await api('POST', `/api/channels/${chGood.data.id}/test`, {
  token: jwt,
  body: { models: ['gpt-test'] },
});
check(
  'channel test ok',
  tGood.status === 201 && tGood.data.summary?.ok === 1 && tGood.data.results?.[0]?.sample === 'Hello from mock',
  tGood.data,
);
const tBad = await api('POST', `/api/channels/${chBad.data.id}/test`, { token: jwt, body: {} });
check(
  'channel test failure reported',
  tBad.status === 201 && tBad.data.summary?.failed === 1 && tBad.data.results?.[0]?.status === 500,
  tBad.data,
);
const tMissing = await api('POST', `/api/channels/00000000-0000-0000-0000-000000000000/test`, { token: jwt, body: {} });
check('channel test unknown id -> 404', tMissing.status === 404, tMissing.status);

// 弹窗内测试（未保存配置）+ 多模型批量
const tcInline = await api('POST', '/api/channels/test-connection', {
  token: jwt,
  body: { provider: 'openai', baseUrl: 'http://localhost:4001/good/v1', apiKey: 'inline-key', models: ['gpt-test'] },
});
check('test-connection inline ok', tcInline.status === 201 && tcInline.data.summary?.ok === 1, tcInline.data);
const tcMulti = await api('POST', '/api/channels/test-connection', {
  token: jwt,
  body: {
    provider: 'openai',
    baseUrl: 'http://localhost:4001/good/v1',
    apiKey: 'inline-key',
    models: ['gpt-test', 'claude-test', 'gemini-test'],
  },
});
check(
  'test-connection batch tests all models',
  tcMulti.status === 201 && tcMulti.data.summary?.total === 3 && tcMulti.data.summary?.ok === 3 && tcMulti.data.results.length === 3,
  tcMulti.data,
);
const tcStored = await api('POST', '/api/channels/test-connection', {
  token: jwt,
  body: { provider: 'openai', baseUrl: 'http://localhost:4001/good/v1', channelId: chGood.data.id, models: ['gpt-test'] },
});
check('test-connection reuses stored key', tcStored.status === 201 && tcStored.data.summary?.ok === 1, tcStored.data);
const tcNoModel = await api('POST', '/api/channels/test-connection', {
  token: jwt,
  body: { provider: 'openai', baseUrl: 'http://localhost:4001/good/v1', apiKey: 'k' },
});
check('test-connection requires model -> 400', tcNoModel.status === 400, tcNoModel.status);

// 编辑渠道（PATCH，未传 apiKey 保留原密钥）
const edit = await api('PATCH', `/api/channels/${chGood.data.id}`, {
  token: jwt,
  body: { name: 'good-openai-edited', priority: 7 },
});
check(
  'edit channel updates fields',
  edit.status === 200 && edit.data.name === 'good-openai-edited' && edit.data.priority === 7 && edit.data.hasApiKey === true,
  edit.data,
);

// 1. 无 key
const noKey = await fetch(API + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] }),
});
check('no key -> 401', noKey.status === 401, noKey.status);

// 2. 未知模型
const unknown = await fetch(API + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sk}` },
  body: JSON.stringify({ model: 'nope', messages: [] }),
});
check('unknown model -> 404', unknown.status === 404, unknown.status);

// 3. OpenAI 非流式 + 故障转移（bad 优先级更高，应自动降级到 good）
const nonStream = await fetch(API + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sk}` },
  body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] }),
});
const nonStreamJson = await nonStream.json();
check('openai non-stream 200', nonStream.status === 200, nonStreamJson);
check('openai non-stream content', nonStreamJson.choices?.[0]?.message?.content === 'Hello from mock', nonStreamJson);
check('openai non-stream usage', nonStreamJson.usage?.total_tokens === 18, nonStreamJson.usage);

// 4. OpenAI 流式
const s1 = await collectStream('/v1/chat/completions', sk, {
  model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'hi' }],
});
check('openai stream 200', s1.status === 200, s1.status);
check('openai stream has content chunks', s1.text.includes('"content":"Hello"'), s1.text.slice(0, 200));
check('openai stream DONE', s1.text.includes('data: [DONE]'), s1.text.slice(-120));

// 5. Anthropic 非流式（协议转换）
const anth = await fetch(API + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sk}` },
  body: JSON.stringify({ model: 'claude-test', messages: [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hi' }] }),
});
const anthJson = await anth.json();
check('anthropic non-stream 200', anth.status === 200, anthJson);
check('anthropic -> openai shape', anthJson.object === 'chat.completion' && anthJson.choices?.[0]?.message?.content === 'Hello from claude', anthJson);
check('anthropic usage mapped', anthJson.usage?.prompt_tokens === 9 && anthJson.usage?.completion_tokens === 5, anthJson.usage);

// 6. Anthropic 流式（SSE 事件 -> OpenAI chunk）
const s2 = await collectStream('/v1/chat/completions', sk, {
  model: 'claude-test', stream: true, messages: [{ role: 'user', content: 'hi' }],
});
check('anthropic stream 200', s2.status === 200, s2.status);
check('anthropic stream converted to openai chunk', s2.text.includes('"object":"chat.completion.chunk"') && s2.text.includes('"content":"Hello"'), s2.text.slice(0, 300));
check('anthropic stream DONE', s2.text.includes('data: [DONE]'), s2.text.slice(-120));

// 7. Gemini 非流式（原生协议转换）
const gem = await fetch(API + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sk}` },
  body: JSON.stringify({ model: 'gemini-test', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] }),
});
const gemJson = await gem.json();
check('gemini non-stream 200', gem.status === 200, gemJson);
check('gemini -> openai shape', gemJson.object === 'chat.completion' && gemJson.choices?.[0]?.message?.content === 'Hello gemini', gemJson);
check('gemini usage mapped', gemJson.usage?.prompt_tokens === 8 && gemJson.usage?.completion_tokens === 4, gemJson.usage);

// 8. Gemini 流式（SSE -> OpenAI chunk）
const s3 = await collectStream('/v1/chat/completions', sk, {
  model: 'gemini-test', stream: true, messages: [{ role: 'user', content: 'hi' }],
});
check('gemini stream 200', s3.status === 200, s3.status);
check('gemini stream converted', s3.text.includes('"object":"chat.completion.chunk"') && s3.text.includes('"content":"Hello"'), s3.text.slice(0, 300));
check('gemini stream DONE', s3.text.includes('data: [DONE]'), s3.text.slice(-120));

// 8.5. embeddings（OpenAI 兼容透传：批量/单条/入参校验/鉴权）
const emb = await api('POST', '/v1/embeddings', {
  token: sk,
  body: { model: 'gpt-test', input: ['hello world', 'embed me'] },
});
check('embeddings 200', emb.status === 200, emb.data);
check(
  'embeddings data shape',
  emb.data?.object === 'list' &&
    Array.isArray(emb.data?.data) &&
    emb.data.data.length === 2 &&
    emb.data.data[0]?.object === 'embedding' &&
    emb.data.data[0]?.index === 0 &&
    Array.isArray(emb.data.data[0]?.embedding),
  emb.data,
);
check(
  'embeddings usage',
  emb.data?.usage?.prompt_tokens === 7 && emb.data?.usage?.total_tokens === 7,
  emb.data?.usage,
);
const embOne = await api('POST', '/v1/embeddings', {
  token: sk,
  body: { model: 'gpt-test', input: 'single string' },
});
check('embeddings single string -> 1 vector', embOne.status === 200 && embOne.data?.data?.length === 1, embOne.data);
const embNoInput = await api('POST', '/v1/embeddings', { token: sk, body: { model: 'gpt-test' } });
check('embeddings missing input -> 400', embNoInput.status === 400, embNoInput.data);
const embNoModel = await api('POST', '/v1/embeddings', { token: sk, body: { input: 'x' } });
check('embeddings missing model -> 400', embNoModel.status === 400, embNoModel.data);
const embNoKey = await api('POST', '/v1/embeddings', { body: { model: 'gpt-test', input: 'x' } });
check('embeddings no api key -> 401', embNoKey.status === 401, embNoKey.data);

// 9. /v1/models
const models = await fetch(API + '/v1/models', { headers: { Authorization: `Bearer ${sk}` } });
const modelsJson = await models.json();
const ids = (modelsJson.data || []).map((m) => m.id);
check('/v1/models lists channels', ids.includes('gpt-test') && ids.includes('claude-test'), ids);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
