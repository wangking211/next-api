#!/usr/bin/env node

/**
 * 模型对账（Model Audit）：对比「上游可用模型 / 渠道声明模型 / 模型目录 / 渠道×模型映射」，
 * 输出缺口报告，可选自动补齐渠道声明。
 *
 * 背景：曾出现「渠道声明 2 个、上游实际 25 个」「baseUrl 少了 /v1 导致全渠道 405」
 * 这类静默配置故障，本脚本用于定期巡检。
 *
 * 环境变量（密钥只从环境读取，不写入输出）：
 *   AIGW_BASE_URL       平台地址，默认 https://xiaopuyun.com
 *   AIGW_IDENTIFIER     管理员账号（默认 admin）
 *   AIGW_PASSWORD       管理员口令（与 AIGW_TOKEN 二选一）
 *   AIGW_TOKEN          直接提供 accessToken（优先于账号口令）
 *   AIGW_CHANNEL        仅审计指定渠道（名称或 id，可逗号分隔）
 *   AIGW_APPLY          true = 把上游模型集合写回渠道声明（默认 false，只读）
 *   AIGW_PROBE          true = 逐模型真实探针（慢，默认 false）
 *   AIGW_OUT_DIR        报告输出目录，默认 .model-audit
 *
 * 运行：
 *   AIGW_PASSWORD=... node scripts/model-audit.mjs
 *   AIGW_PASSWORD=... AIGW_APPLY=true node scripts/model-audit.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const base = (process.env.AIGW_BASE_URL || 'https://xiaopuyun.com').replace(/\/+$/, '');
const identifier = process.env.AIGW_IDENTIFIER || 'admin';
const password = process.env.AIGW_PASSWORD;
let token = process.env.AIGW_TOKEN?.trim();
const channelFilter = (process.env.AIGW_CHANNEL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const apply = process.env.AIGW_APPLY === 'true';
const probe = process.env.AIGW_PROBE === 'true';
const outDir = path.resolve(process.env.AIGW_OUT_DIR || '.model-audit');
const timeoutMs = Number(process.env.AIGW_TIMEOUT_MS || 60000);

const api = async (method, urlPath, body) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
};

const uniqSorted = (arr) => [...new Set(arr)].sort();

async function login() {
  if (token) return;
  if (!password) {
    console.error('缺少 AIGW_PASSWORD 或 AIGW_TOKEN（管理员凭据）。');
    process.exit(2);
  }
  const r = await api('POST', '/api/auth/login', { identifier, password });
  if (!r.ok || !r.json?.accessToken) {
    console.error(`登录失败: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    process.exit(2);
  }
  token = r.json.accessToken;
}

/** 拉上游模型列表；若原始 baseUrl 失败且不含版本前缀，补 /v1 重试（历史踩坑点） */
async function fetchUpstream(channel) {
  const attempt = async (baseUrl) =>
    api('POST', '/api/channels/fetch-models', {
      provider: channel.provider,
      baseUrl,
      channelId: channel.id,
    });
  let used = channel.baseUrl;
  let r = await attempt(channel.baseUrl);
  let retried = false;
  const needsRetry =
    !r.ok && typeof channel.baseUrl === 'string' && !/\/v\d+(beta)?$/i.test(channel.baseUrl);
  if (needsRetry) {
    used = `${channel.baseUrl.replace(/\/+$/, '')}/v1`;
    r = await attempt(used);
    retried = true;
  }
  if (!r.ok) {
    return { ok: false, used, retried, error: `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 160)}` };
  }
  return { ok: true, used, retried, models: uniqSorted(r.json?.models ?? []) };
}

async function probeModels(channelId, baseUrl, models) {
  const out = new Map();
  for (let i = 0; i < models.length; i += 12) {
    const batch = models.slice(i, i + 12);
    const r = await api('POST', '/api/channels/test-connection', {
      provider: 'custom',
      baseUrl,
      channelId,
      models: batch,
    });
    if (!r.ok) {
      for (const m of batch) out.set(m, { ok: false, error: `HTTP ${r.status}` });
      continue;
    }
    for (const row of r.json?.results ?? []) {
      out.set(row.model, { ok: !!row.ok, status: row.status, error: row.error });
    }
  }
  return out;
}

function section(title) {
  console.log(`\n──────── ${title} ────────`);
}

async function main() {
  await login();
  const chRes = await api('GET', '/api/channels?page=1&pageSize=200');
  if (!chRes.ok) {
    console.error(`获取渠道失败: HTTP ${chRes.status}`);
    process.exit(1);
  }
  let channels = chRes.json?.items ?? [];
  if (channelFilter.length) {
    channels = channels.filter((c) => channelFilter.includes(c.id) || channelFilter.includes(c.name));
  }
  const catRes = await api('GET', '/api/models?page=1&pageSize=300');
  const catalog = (Array.isArray(catRes.json) ? catRes.json : (catRes.json?.items ?? [])).map((m) => m.name);
  const catalogSet = new Set(catalog);

  const report = {
    generatedAt: new Date().toISOString(),
    base,
    apply,
    channels: [],
    catalogSize: catalogSet.size,
    unionUpstream: [],
    catalogNotServed: [],
  };

  for (const ch of channels) {
    const declared = uniqSorted(ch.models ?? []);
    // 对外规范名 → 上游真实名（模型映射）
    const mapping = new Map(
      (ch.modelPrices ?? []).map((p) => [p.model, p.upstreamModelName]).filter(([, v]) => !!v),
    );
    const declaredUpstream = uniqSorted(declared.map((m) => mapping.get(m) ?? m));
    const declaredUpstreamSet = new Set(declaredUpstream);

    const up = await fetchUpstream(ch);
    const entry = {
      id: ch.id,
      name: ch.name,
      provider: ch.provider,
      baseUrl: ch.baseUrl,
      upstreamBaseUrl: up.used,
      retriedWithV1: !!up.retried,
      status: ch.status,
      declaredCount: declared.length,
      upstreamCount: up.ok ? up.models.length : null,
      upstreamError: up.ok ? null : up.error,
      upstreamModels: up.ok ? up.models : [],
      missingInChannel: [],
      staleInChannel: [],
      notInCatalog: [],
      mapped: Object.fromEntries(mapping),
      probeFailures: [],
    };

    if (up.ok) {
      entry.missingInChannel = up.models.filter((m) => !declaredUpstreamSet.has(m));
      entry.staleInChannel = declaredUpstream.filter((m) => !up.models.includes(m));
      entry.notInCatalog = up.models.filter((m) => !catalogSet.has(m));
      if (probe && up.models.length) {
        const results = await probeModels(ch.id, up.used, up.models);
        entry.probeFailures = [...results.entries()]
          .filter(([, v]) => !v.ok)
          .map(([m, v]) => ({ model: m, error: v.error ?? `HTTP ${v.status}` }));
      }
      if (apply && entry.missingInChannel.length) {
        const next = uniqSorted([...declared, ...entry.missingInChannel]);
        const patch = await api('PATCH', `/api/channels/${ch.id}`, { models: next });
        entry.applied = patch.ok ? 'ok' : `HTTP ${patch.status}`;
      }
    }

    report.channels.push(entry);
  }

  report.unionUpstream = uniqSorted(report.channels.flatMap((c) => c.upstreamModels));
  report.catalogNotServed = catalog.filter((m) => !report.unionUpstream.includes(m));

  // ---- 控制台报告 ----
  for (const c of report.channels) {
    section(`${c.name} (${c.provider})`);
    console.log(`baseUrl: ${c.baseUrl}${c.retriedWithV1 ? `  ⚠️ 原始地址失败，改用 ${c.upstreamBaseUrl} 才成功（疑似缺 /v1）` : ''}`);
    if (c.upstreamError) {
      console.log(`上游模型列表获取失败: ${c.upstreamError}`);
      continue;
    }
    console.log(`上游可用 ${c.upstreamCount} 个 / 渠道声明 ${c.declaredCount} 个${c.applied ? `（已补齐: ${c.applied}）` : ''}`);
    if (c.missingInChannel.length) console.log(`  声明缺失 (${c.missingInChannel.length}): ${c.missingInChannel.join(', ')}`);
    if (c.staleInChannel.length) console.log(`  疑似失效 (${c.staleInChannel.length}): ${c.staleInChannel.join(', ')}`);
    if (c.notInCatalog.length) console.log(`  目录未登记 (${c.notInCatalog.length}): ${c.notInCatalog.join(', ')}`);
    if (c.probeFailures.length) console.log(`  探针失败 (${c.probeFailures.length}): ${c.probeFailures.map((f) => f.model).join(', ')}`);
    if (!c.missingInChannel.length && !c.staleInChannel.length && !c.notInCatalog.length) console.log('  ✅ 无缺口');
  }

  section('全局汇总');
  console.log(`渠道 ${report.channels.length} 个；上游模型并集 ${report.unionUpstream.length} 个；目录 ${report.catalogSize} 个`);
  const broken = report.channels.filter((c) => c.upstreamError);
  if (broken.length) console.log(`⚠️ 上游列表不可用: ${broken.map((c) => c.name).join(', ')}`);
  const cm = report.channels.filter((c) => c.retriedWithV1);
  if (cm.length) console.log(`⚠️ baseUrl 疑似缺 /v1: ${cm.map((c) => c.name).join(', ')}`);
  if (report.catalogNotServed.length) {
    console.log(`⚠️ 目录中无任何上游可服务 (${report.catalogNotServed.length}): ${report.catalogNotServed.join(', ')}`);
  }

  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `model-audit-${stamp}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n报告已写入: ${jsonPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
