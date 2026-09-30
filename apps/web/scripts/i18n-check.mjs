#!/usr/bin/env node
/**
 * i18n 字典一致性校验（由 `pnpm --filter @ai-gateway/web typecheck` 调用）：
 * 1. zh-CN / zh-Hant / en 三个语言目录下的模块 JSON 键集必须完全一致；
 * 2. 同一语言内不允许跨模块重复键（合并时会静默覆盖）；
 * 3. 不允许空值（未翻译占位）；
 * 4. 英文文案不允许与 zh-CN 逐字相同（漏翻最常见的形态）——技术术语走白名单。
 * 失败以退出码 1 结束（阻断 typecheck/CI）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n', 'locales');
const BASE = 'zh-CN';
const EN = 'en';

/**
 * 技术术语豁免：这些值在三语言里本就保持英文（或符号），不参与「英文漏翻」判定。
 * 新增豁免时必须确认是产品有意保留的写法，而不是偷懒没翻。
 */
const TECH_TERM_WHITELIST = new Set(['IP', 'API Key', 'RPM', '-']);

const locales = readdirSync(localesRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

function loadLocale(locale) {
  const dir = join(localesRoot, locale);
  const keys = new Map(); // key -> file
  const values = new Map(); // key -> value
  const errors = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let obj;
    try {
      obj = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (e) {
      errors.push(`${locale}/${f}: JSON 解析失败 - ${e.message}`);
      continue;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (keys.has(k)) errors.push(`${locale}: 键 "${k}" 在 ${keys.get(k)} 与 ${f} 中重复`);
      keys.set(k, `${locale}/${f}`);
      values.set(k, v);
      if (typeof v !== 'string' || v.trim() === '') {
        errors.push(`${locale}/${f}: 键 "${k}" 的值为空或非字符串`);
      }
    }
  }
  return { keys, values, errors };
}

const loaded = Object.fromEntries(locales.map((l) => [l, loadLocale(l)]));
const problems = locales.flatMap((l) => loaded[l].errors);

const base = loaded[BASE];
if (!base) {
  problems.push(`缺少基准语言目录 ${BASE}`);
} else {
  for (const l of locales) {
    if (l === BASE) continue;
    const other = loaded[l];
    for (const k of base.keys.keys()) {
      if (!other.keys.has(k)) problems.push(`${l}: 缺少键 "${k}"（基准 ${base.keys.get(k)}）`);
    }
    for (const k of other.keys.keys()) {
      if (!base.keys.has(k)) problems.push(`${l}: 多出键 "${k}"（不在 ${BASE} 中）`);
    }
  }

  // 英文漏翻：只比 en↔zh-CN（zh-Hant 与 zh-CN 同字属正常，不参与判定）
  const en = loaded[EN];
  if (en) {
    for (const [k, enValue] of en.values) {
      const baseValue = base.values.get(k);
      if (typeof enValue !== 'string' || enValue !== baseValue) continue;
      if (!/[A-Za-z]/.test(enValue)) continue; // 纯符号/数字，无翻译可言
      if (TECH_TERM_WHITELIST.has(enValue)) continue;
      problems.push(
        `${EN}: 键 "${k}" 与 ${BASE} 逐字相同，疑似漏翻："${enValue}"（确为技术术语请加入白名单）`,
      );
    }
  }
}

if (problems.length) {
  console.error(`i18n 校验失败（${problems.length} 处）：`);
  for (const p of problems.slice(0, 60)) console.error('  - ' + p);
  if (problems.length > 60) console.error(`  …以及另外 ${problems.length - 60} 处`);
  process.exit(1);
}
console.log(
  `i18n 校验通过：${locales.join(' / ')} 共 ${base.keys.size} 键（${locales.length} 语言 × ${base.keys.size}）`,
);
