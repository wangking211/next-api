#!/usr/bin/env node

/**
 * 全渠道 × 全模型 连通性巡检（平台内置 testChannel，最小聊天探针 "ping"）：
 *  - 分块（≤8/块，DTO 上限 20）避免单请求超时；块间串行，块内服务端并发
 *  - 分类：ok / 媒体模型(聊天探针不适用，按目录 capabilities 标注) / 余额 / 模型不存在 / 鉴权 / 其它失败
 *  - 网络级失败重试 1 次
 *  - 只做连通性，不做真实生成调用
 *
 * 运行：
 *   AIGW_PASSWORD=... node tools/verify/channel-probe.mjs
 *   AIGW_PASSWORD=... AIGW_CHANNEL=tokenfleetAI node tools/verify/channel-probe.mjs   # 只巡检指定渠道
 *
 * 环境变量见 lib.mjs；额外：
 *   AIGW_CHANNEL   仅巡检指定渠道（名称或 id，可逗号分隔）
 *   AIGW_CHUNK     每批探测模型数，默认 8（DTO 上限 20）
 */

import { api, base, login, rows } from './lib.mjs';

const CHUNK = Math.min(Number(process.env.AIGW_CHUNK || 8), 20);
const channelFilter = (process.env.AIGW_CHANNEL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

await login();

// 目录 capabilities（区分媒体模型）
const catRes = await api('GET', '/api/models?page=1&pageSize=300');
const capByModel = new Map(rows(catRes.json).map((m) => [m.name, new Set(m.capabilities ?? [])]));
const isMedia = (name) => {
  const caps = capByModel.get(name);
  if (caps && (caps.has('image') || caps.has('video') || caps.has('audio'))) return true;
  return /image|seedance|kling|nano-banana|sora|tts|whisper|embedding/i.test(name);
};

const chRes = await api('GET', '/api/channels?page=1&pageSize=200');
let channels = rows(chRes.json);
if (channelFilter.length) {
  channels = channels.filter((c) => channelFilter.includes(c.id) || channelFilter.includes(c.name));
}

const all = []; // { channel, model, ok, status, latencyMs, error, media }
const started = Date.now();

console.log(`base=${base} channels=${channels.length} chunk=${CHUNK}`);

for (const ch of channels) {
  const models = ch.models ?? [];
  console.log(
    `\n### ${ch.name} | ${ch.baseUrl} | prio=${ch.priority} status=${ch.status} | models=${models.length}`,
  );
  for (let i = 0; i < models.length; i += CHUNK) {
    const chunk = models.slice(i, i + CHUNK);
    const run = () =>
      api('POST', `/api/channels/${ch.id}/test`, {
        body: { models: chunk },
        timeoutMs: 240000,
      });
    let r = await run();
    if (!r.ok || !Array.isArray(r.json?.results)) {
      console.log(`  chunk ${i}-${i + chunk.length} HTTP ${r.status}, retrying...`);
      await new Promise((s) => setTimeout(s, 2000));
      r = await run();
    }
    if (!r.ok || !Array.isArray(r.json?.results)) {
      console.log(`  chunk FAILED HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
      for (const m of chunk) {
        all.push({
          channel: ch.name,
          model: m,
          ok: false,
          status: r.status,
          error: 'probe-request-failed',
          media: isMedia(m),
        });
      }
      continue;
    }
    for (const res of r.json.results) {
      all.push({
        channel: ch.name,
        model: res.model,
        ok: !!res.ok,
        status: res.status,
        latencyMs: res.latencyMs,
        error: res.error ? String(res.error).slice(0, 180) : '',
        media: isMedia(res.model),
      });
    }
    const done = Math.min(i + CHUNK, models.length);
    console.log(
      `  [${done}/${models.length}] chunk ok=${r.json.summary?.ok} failed=${r.json.summary?.failed} elapsed=${Math.round((Date.now() - started) / 1000)}s`,
    );
  }
}

// ---------- 汇总 ----------
const MEDIA_PAT =
  /media model|router\/task|not supported.*(image|video)|use.*(image|video).*endpoint/i;
console.log(
  `\n========== SUMMARY (probes: ${all.length}, ${Math.round((Date.now() - started) / 1000)}s) ==========`,
);
for (const ch of channels) {
  const list = all.filter((r) => r.channel === ch.name);
  const ok = list.filter((r) => r.ok);
  const fail = list.filter((r) => !r.ok);
  console.log(
    `\n--- ${ch.name} (${ch.baseUrl}) prio=${ch.priority}: OK ${ok.length}/${list.length} ---`,
  );
  console.log(`  OK: ${ok.map((r) => r.model).join(', ') || '(none)'}`);
  for (const f of fail) {
    const tag = f.media ? '[media]' : MEDIA_PAT.test(f.error) ? '[media-probe-n/a]' : '';
    console.log(`  FAIL ${f.model} status=${f.status} ${tag} :: ${f.error}`);
  }
}

// 失败原因归类
const classify = (f) => {
  if (f.status === 402 || /insufficient|balance|余额|充值/i.test(f.error)) {
    return 'INSUFFICIENT_BALANCE(402)';
  }
  if (f.status === 404 || /model.*not found|not.*exist|no such model/i.test(f.error)) {
    return 'MODEL_NOT_FOUND(404)';
  }
  if (
    f.status === 401 ||
    f.status === 403 ||
    /unauthorized|invalid.*key|authentication|鉴权/i.test(f.error)
  ) {
    return 'AUTH(401/403)';
  }
  if (f.status === 429 || /rate.?limit/i.test(f.error)) return 'RATE_LIMIT(429)';
  if (f.media || MEDIA_PAT.test(f.error)) return 'MEDIA_MODEL(chat probe n/a)';
  if (f.status === 0) return 'NETWORK/TIMEOUT';
  if (f.status >= 500) return `UPSTREAM_5xx(${f.status})`;
  return `HTTP_${f.status}`;
};

const groups = new Map();
for (const f of all.filter((r) => !r.ok)) {
  const reason = classify(f);
  if (!groups.has(reason)) groups.set(reason, []);
  groups.get(reason).push(`${f.channel}:${f.model}`);
}
console.log('\n--- failure groups ---');
for (const [reason, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${reason} (${items.length}): ${items.join(', ')}`);
}
console.log(`\nTOTAL: ${all.filter((r) => r.ok).length}/${all.length} chat-probe OK`);
