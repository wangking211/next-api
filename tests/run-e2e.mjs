#!/usr/bin/env node
/**
 * 端到端测试编排器（独立数据源，可重复运行）。
 *
 * 隔离策略：
 * - 数据库：默认使用 `<原库名>_e2e`（`E2E_DATABASE_URL` 可覆盖），与开发库互不影响；
 *   每次运行前重建 schema（DROP SCHEMA public CASCADE）并重新 `prisma migrate deploy`，
 *   保证与 CI 相同的全新状态，本地可反复执行、结果稳定。
 * - Redis：默认 db 15（`E2E_REDIS_URL` 可覆盖），运行前 FLUSHDB，避免登录/RPM 限流
 *   计数等残留影响重跑。
 * - 所有子进程（mock / API / 测试脚本）继承上述 env；进程环境变量优先级高于 .env 文件，
 *   因此 API 即使读到 apps/api/.env 也只会使用隔离数据源。
 *
 * 前置条件：PostgreSQL/Redis 已启动，且 API 已构建（pnpm --filter @ai-gateway/api build）。
 * 用法：node tests/run-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pgModule from 'pg';
import redisModule from 'ioredis';

// CJS 互操作：pg 以对象导出；ioredis 可能是构造函数本身或 {default: 构造函数}，两种形态都兼容
const { Client: PgClient } = pgModule;
const Redis = redisModule.default ?? redisModule;

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const apiDir = join(root, 'apps', 'api');
const apiEntry = join(apiDir, 'dist', 'main.js');

if (!existsSync(apiEntry)) {
  console.error(`未找到 ${apiEntry}，请先执行：pnpm --filter @ai-gateway/api build`);
  process.exit(1);
}

// ---------- 数据源隔离 ----------
const baseDbUrl =
  process.env.DATABASE_URL ||
  'postgresql://aigw:aigw_dev_pass@localhost:5432/ai_gateway?schema=public';
const e2eDbUrl = process.env.E2E_DATABASE_URL || deriveE2eDbUrl(baseDbUrl);
const baseRedisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const e2eRedisUrl = process.env.E2E_REDIS_URL || deriveE2eRedisUrl(baseRedisUrl);

function deriveE2eDbUrl(url) {
  const u = new URL(url);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}_e2e`;
  return u.toString();
}

function deriveE2eRedisUrl(url) {
  const u = new URL(url);
  u.pathname = '/15';
  return u.toString();
}

/** 换库名并去掉 Prisma 的 ?schema= 等查询参数（pg 客户端用） */
function withDbPath(url, pathname) {
  const u = new URL(url);
  u.pathname = pathname;
  u.search = '';
  return u.toString();
}

function dbPath(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
}

/** 目标库不存在则创建（库已存在时 Postgres 返回 42P04，忽略即可） */
async function ensureE2eDatabase() {
  const admin = new PgClient({ connectionString: withDbPath(baseDbUrl, '/postgres') });
  await admin.connect();
  try {
    const name = dbPath(e2eDbUrl).replace(/"/g, '""');
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (e) {
    if (e?.code !== '42P04') throw e;
  } finally {
    await admin.end();
  }
}

/** 重建 schema：清空上次运行残留，等价于 CI 上的全新数据库 */
async function resetE2eSchema() {
  const client = new PgClient({ connectionString: toPgUrl(e2eDbUrl) });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
}

/** 对隔离库执行正式迁移（与生产同源的 migrations，不用 db push） */
function runMigrations() {
  const prismaCli = join(apiDir, 'node_modules', 'prisma', 'build', 'index.js');
  if (!existsSync(prismaCli)) {
    return Promise.reject(new Error(`未找到 Prisma CLI（${prismaCli}），请先执行 pnpm install`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: e2eDbUrl },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`prisma migrate deploy 退出码 ${code}`)),
    );
    child.on('error', reject);
  });
}

/** 清空隔离 Redis db（限流计数、缓存残留都会在这里清掉） */
async function flushRedis() {
  const redis = new Redis(e2eRedisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null, // 不重试：Redis 不可达立即失败
  });
  redis.on('error', () => {
    /* 连接错误通过 flushdb 的 rejection 上抛，这里吞掉避免未处理 error 事件 */
  });
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

function toPgUrl(url) {
  const u = new URL(url);
  u.search = '';
  return u.toString();
}

async function prepareIsolation() {
  if (e2eDbUrl === baseDbUrl) {
    throw new Error('E2E_DATABASE_URL 与 DATABASE_URL 相同，拒绝在非隔离库上运行 e2e');
  }
  console.log(`[e2e] 数据库：${dbPath(e2eDbUrl)}（重建 schema + migrate deploy）`);
  await ensureE2eDatabase();
  await resetE2eSchema();
  await runMigrations();
  console.log(`[e2e] Redis：flush ${new URL(e2eRedisUrl).pathname || '/0'}`);
  await flushRedis();
  // 子进程与测试脚本统一使用隔离数据源（进程 env 优先于 .env 文件）
  process.env.DATABASE_URL = e2eDbUrl;
  process.env.REDIS_URL = e2eRedisUrl;
}

// ---------- 进程编排 ----------
const children = [];
function killAll() {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* 进程可能已退出 */
    }
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
    } catch {
      /* 服务尚未就绪 */
    }
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
try {
  await prepareIsolation();
} catch (e) {
  console.error(`[e2e] 隔离准备失败：${e?.message ?? e}`);
  process.exit(1);
}

try {
  start('mock', [join(__dirname, 'mock-upstream.mjs')], root);
  start('api', [apiEntry], apiDir, {
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
