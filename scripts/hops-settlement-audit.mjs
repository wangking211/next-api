#!/usr/bin/env node

/**
 * HopsAPI settlement audit.
 *
 * Secrets are read only from the environment and are never written to output:
 *   HOPS_API_KEY                 required for live model calls
 *   HOPS_SESSION_COOKIE          required for console pricing/usage snapshots
 *   HOPS_CHROME_DEBUG_PORT       optional Chrome CDP port, e.g. 9099; reads the existing session in memory
 *   HOPS_KEY_ID                  optional console key id filter
 *   HOPS_BASE_URL                 optional, defaults to https://hopsapi.com/v1
 *   HOPS_USAGE_DAYS              optional, defaults to 7
 *
 * Run:
 *   HOPS_API_KEY=... HOPS_SESSION_COOKIE='...' node scripts/hops-settlement-audit.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const apiKey = process.env.HOPS_API_KEY?.trim();
const baseUrl = (process.env.HOPS_BASE_URL || 'https://hopsapi.com/v1').replace(/\/$/, '');
const sessionCookie = process.env.HOPS_SESSION_COOKIE?.trim();
const chromeDebugPort = process.env.HOPS_CHROME_DEBUG_PORT?.trim();
const usageDays = Number(process.env.HOPS_USAGE_DAYS || 7);
const keyId = process.env.HOPS_KEY_ID?.trim();
const outDir = path.resolve(process.env.HOPS_AUDIT_DIR || '.hops-audit');
const requestTimeoutMs = Number(process.env.HOPS_REQUEST_TIMEOUT_MS || 30000);

if (!apiKey) {
  console.error('Missing HOPS_API_KEY. Set the dedicated test key in the environment.');
  process.exit(2);
}

const json = (value) => JSON.stringify(value, null, 2);
const now = new Date();
const isoDay = (d) => d.toISOString().slice(0, 10);
const start = new Date(now.getTime() - Math.max(1, usageDays) * 86400000);

async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const response = await fetch(url, {
    ...options,
    signal: controller.signal,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  clearTimeout(timeout);
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text.slice(0, 4000); }
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function hopsApi(pathname, options = {}) {
  return request(`${baseUrl}${pathname}`, {
    ...options,
    headers: { authorization: `Bearer ${apiKey}`, ...(options.headers || {}) },
  });
}

async function chromeCookieHeader() {
  if (!chromeDebugPort) return null;
  try {
    const pages = await request(`http://127.0.0.1:${chromeDebugPort}/json/list`);
    const page = pages.find((p) => p.type === 'page' && p.url.includes('hopsapi.com/agent/'));
    if (!page?.webSocketDebuggerUrl) return null;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const cookies = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome CDP timeout')), 5000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' })));
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        ws.close();
        resolve(message.result?.cookies || []);
      });
      ws.addEventListener('error', reject);
    });
    const cookieHeader = cookies.filter((c) => c.domain.includes('hopsapi.com')).map((c) => `${c.name}=${c.value}`).join('; ');
    const tokenWs = new WebSocket(page.webSocketDebuggerUrl);
    const token = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome token timeout')), 5000);
      tokenWs.addEventListener('open', () => tokenWs.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'localStorage.getItem("tg_token")', returnByValue: true } })));
      tokenWs.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 2) return;
        clearTimeout(timer);
        tokenWs.close();
        resolve(message.result?.result?.value || null);
      });
      tokenWs.addEventListener('error', reject);
    });
    return { cookie: cookieHeader, token };
  } catch {
    return null;
  }
}

const browserSession = sessionCookie ? { cookie: sessionCookie, token: null } : await chromeCookieHeader();
const browserCookie = browserSession?.cookie || null;
const browserToken = browserSession?.token || null;

async function hopsConsole(pathname) {
  if (!browserCookie) return { unavailable: true, reason: 'HOPS_SESSION_COOKIE and HOPS_CHROME_DEBUG_PORT are not available' };
  try {
    return await request(`https://hopsapi.com/webapi${pathname}`, { headers: { cookie: browserCookie, ...(browserToken ? { authorization: `Bearer ${browserToken}` } : {}) } });
  } catch (error) {
    return { unavailable: true, status: error.status || 0, error: String(error.message), body: error.body };
  }
}

const modelCatalog = await hopsApi('/models');
const modelIds = (modelCatalog?.data || modelCatalog?.models || [])
  .map((m) => typeof m === 'string' ? m : m.id)
  .filter(Boolean);

const results = new Array(modelIds.length);
let cursor = 0;
async function testWorker() {
  while (cursor < modelIds.length) {
    const index = cursor++;
    const model = modelIds[index];
  const started = Date.now();
  const payload = {
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    max_tokens: 8,
    temperature: 0,
    stream: false,
  };
  try {
    const response = await hopsApi('/chat/completions', { method: 'POST', body: JSON.stringify(payload) });
    const usage = response?.usage || {};
    results[index] = { model, ok: true, latency_ms: Date.now() - started, usage: {
      input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
      output_tokens: usage.completion_tokens ?? usage.output_tokens ?? null,
      total_tokens: usage.total_tokens ?? null,
    }, response_id: response?.id || null };
  } catch (error) {
    results[index] = { model, ok: false, latency_ms: Date.now() - started, status: error.status || 0, error: error.body || error.message };
  }
  }
}
await Promise.all(Array.from({ length: Math.min(3, modelIds.length) }, () => testWorker()));

const pricing = await hopsConsole('/agent/pricing');
const usageQuery = new URLSearchParams({
  start_timestamp: String(Math.floor(start.getTime() / 1000)),
  end_timestamp: String(Math.floor(now.getTime() / 1000) + 1),
  page: '1',
  page_size: '200',
});
if (keyId) usageQuery.set('key_id', keyId);
const usage = await hopsConsole(`/agent/usage?${usageQuery}`);
const usageSummary = await hopsConsole(`/agent/usage/summary?${usageQuery}`);

const output = {
  audit: { started_at: now.toISOString(), start_date: isoDay(start), end_date: isoDay(now), base_url: baseUrl, model_count: modelIds.length },
  models: modelCatalog,
  call_results: results,
  pricing,
  usage,
  usage_summary: usageSummary,
  notes: [
    'The dedicated test key was used for live calls; the key itself is intentionally excluded.',
    'Console pricing and usage require HOPS_SESSION_COOKIE; missing snapshots are reported as unavailable rather than inferred.',
    'A settlement-vs-direct-provider comparison must be joined to current first-party price baselines in the final report.',
  ],
};

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, 'audit.json'), `${json(output)}\n`, { mode: 0o600 });
console.log(json({ out_dir: outDir, model_count: modelIds.length, calls_ok: results.filter((r) => r.ok).length, calls_failed: results.filter((r) => !r.ok).length, pricing_available: !pricing.unavailable, usage_available: !usage.unavailable }));
