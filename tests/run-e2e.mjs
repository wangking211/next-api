#!/usr/bin/env node
/**
 * 端到端测试编排器。
 * 前置条件：PostgreSQL/Redis 已启动并完成迁移，且 API 已构建（pnpm --filter @ai-gateway/api build）。
 * 用法：node tests/run-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const apiDir = join(root, 'apps', 'api');
const apiEntry = join(apiDir, 'dist', 'main.js');

if (!existsSync(apiEntry)) {
  console.error(`未找到 ${apiEntry}，请先执行：pnpm --filter @ai-gateway/api build`);
  process.exit(1);
}

const children = [];
function killAll() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch {}
  }
}
process.on('exit', killAll);

function start(name, args, cwd, env) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  children.push(child);
  return child;
}

async function waitFor(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function run(label, file) {
  return new Promise((resolve) => {
    console.log(`\n──────── ${label} ────────`);
    const child = spawn(process.execPath, [join(__dirname, file)], {
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const results = [];
let mock, api;
try {
  mock = start('mock', [join(__dirname, 'mock-upstream.mjs')], root);
  api = start('api', [apiEntry], apiDir, {
    CHANNEL_FAILURE_THRESHOLD: '3',
    // 生产默认不记录调用内容（LOG_CONTENT=false）；e2e 需验证「日志详情含输入/输出」，故显式开启
    LOG_CONTENT: 'true',
  });

  const healthy = await waitFor('http://localhost:3000/api/health');
  if (!healthy) {
    console.error('API 未就绪，请确认数据库已迁移且端口 3000 可用。');
    process.exit(1);
  }

  results.push(['API 基础 (P1-P2)', await run('API 基础冒烟 (P1-P2)', 'api-smoke.mjs')]);
  results.push(['网关转发 (P3)', await run('网关转发 (P3)', 'gateway-test.mjs')]);
  results.push(['计量与限流 (P4)', await run('计量与限流 (P4)', 'usage-test.mjs')]);
  results.push(['计费与充值 (P7)', await run('计费与充值 (P7)', 'billing-test.mjs')]);
  results.push(['兑换码 (P8)', await run('兑换码 (P8)', 'redeem-test.mjs')]);
  results.push(['告警与审计 (P10)', await run('告警与审计 (P10)', 'ops-test.mjs')]);
} finally {
  killAll();
}

console.log('\n========== 汇总 ==========');
let failed = 0;
for (const [label, code] of results) {
  console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${label}`);
  if (code !== 0) failed++;
}
process.exit(failed ? 1 : 0);
