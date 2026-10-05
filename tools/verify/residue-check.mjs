#!/usr/bin/env node

/**
 * 残留检查（只读）：确认测试数据没有留在生产上——密钥列表、模型目录嫌疑行、渠道模型数、分组可见范围。
 * 约定：巡检中创建的临时 key / 模型 / 分组，用完必须删掉，本脚本负责事后复核。
 *
 * 运行：
 *   AIGW_PASSWORD=... node tools/verify/residue-check.mjs
 *
 * 环境变量见 lib.mjs；AIGW_SUSPECT 可追加嫌疑关键字（逗号分隔，默认 verify,tmp,test,tmpkey）。
 */

import { api, login, rows } from './lib.mjs';

const suspects = ['verify', 'tmp', 'test', 'tmpkey'].concat(
  (process.env.AIGW_SUSPECT || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

await login();
let failed = 0;

// 1. 密钥：巡检建的临时 key 必须已删除
const keys = await api('GET', '/api/keys');
const keyList = rows(keys.json);
console.log(`keys total: ${keyList.length}`);
for (const k of keyList) {
  console.log(
    `  ${k.name} | group=${k.group?.name ?? k.groupId ?? '-'} | created=${k.createdAt ?? '-'}`,
  );
}
const badKeys = keyList.filter((k) =>
  suspects.some((s) => String(k.name).toLowerCase().includes(s)),
);
if (badKeys.length) {
  failed += 1;
  console.log(
    `  ! 疑似临时密钥未清理 (${badKeys.length}): ${badKeys.map((k) => k.name).join(', ')}`,
  );
}

// 2. 模型目录：临时候选行
const models = await api('GET', '/api/models?page=1&pageSize=300');
const catalog = rows(models.json);
const hits = catalog.filter((m) => suspects.some((s) => String(m.name).toLowerCase().includes(s)));
console.log(
  `\ncatalog rows: ${catalog.length}  enabled: ${catalog.filter((m) => m.enabled).length}`,
);
console.log(`suspect rows: ${hits.length ? hits.map((m) => m.name).join(', ') : '(none)'}`);
if (hits.length) failed += 1;

// 3. 渠道：模型数为 0 的渠道多半是巡检中被改坏的
const chRes = await api('GET', '/api/channels?page=1&pageSize=200');
const channels = rows(chRes.json);
console.log(`\nchannels: ${channels.length}`);
const empty = channels.filter((c) => Array.isArray(c.models) && c.models.length === 0);
for (const c of channels) {
  console.log(`  ${c.name}: ${(c.models ?? []).length} models  (${c.status})`);
}
if (empty.length) {
  failed += 1;
  console.log(`  ! 模型数为 0 的渠道 (${empty.length}): ${empty.map((c) => c.name).join(', ')}`);
}

// 4. 分组：可见模型范围是否符合预期
const groups = await api('GET', '/api/groups');
const groupList = rows(groups.json);
console.log(`\ngroups: ${groupList.length}`);
for (const g of groupList) {
  const names = Array.isArray(g.models) ? g.models.map((m) => m.name ?? m) : [];
  console.log(`  ${g.name}: ${names.length === 0 ? 'unrestricted' : names.length + ' models'}`);
}

console.log(failed ? `\nRESULT: ${failed} section(s) need attention` : '\nRESULT: clean');
if (failed) process.exitCode = 1;
