#!/usr/bin/env node

/**
 * 渠道状态快照（只读）：优先级层级 / 权重 / 状态 / 模型数 / 归属分组，用于解释「流量为什么这样路由」。
 * 收编自临时脚本 list-channels.mjs + prio-snapshot.mjs。
 *
 * 运行：
 *   AIGW_PASSWORD=... node tools/verify/channel-status.mjs
 *   AIGW_PASSWORD=... AIGW_CHANNEL=tokenfleetAI node tools/verify/channel-status.mjs
 *
 * 环境变量见 lib.mjs；AIGW_CHANNEL 可只看指定渠道（名称或 id，可逗号分隔）。
 */

import { api, login, rows } from './lib.mjs';

const channelFilter = (process.env.AIGW_CHANNEL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

await login();

const res = await api('GET', '/api/channels?page=1&pageSize=200');
if (!res.ok) {
  console.error(`获取渠道失败: HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
  process.exit(1);
}
let channels = rows(res.json);
if (channelFilter.length) {
  channels = channels.filter((c) => channelFilter.includes(c.id) || channelFilter.includes(c.name));
}

console.log(`channels: ${channels.length}\n`);

console.log('--- 按优先级倒序（路由选择先看这里）---');
channels
  .slice()
  .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  .forEach((c) =>
    console.log(
      `prio=${String(c.priority).padStart(2)} w=${String(c.weight).padStart(2)} ${c.status} ` +
        `${String(c.name).padEnd(16)} created=${(c.createdAt ?? '-').slice(0, 10)} ` +
        `updated=${(c.updatedAt ?? '-').slice(0, 10)} models=${(c.models ?? []).length}`,
    ),
  );

console.log('\n--- 详情 ---');
for (const c of channels) {
  const groups = (c.groups ?? []).map((g) => g.name ?? g).join(',') || '-';
  console.log(
    `  ${c.name} | provider=${c.provider} | ${c.baseUrl} | origin=${c.origin ?? '-'} | ` +
      `models=${Array.isArray(c.models) ? c.models.length : typeof c.models} | group=${groups}`,
  );
}

const byStatus = new Map();
for (const c of channels) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
console.log('\n--- 汇总 ---');
console.log([...byStatus].map(([s, n]) => `${s}=${n}`).join('  ') || '(no channels)');
console.log(
  `模型数合计 ${channels.reduce((n, c) => n + (Array.isArray(c.models) ? c.models.length : 0), 0)}`,
);
