#!/usr/bin/env node
/**
 * i18n 字典一致性校验（由 `pnpm --filter @ai-gateway/web typecheck` 调用）：
 * 1. zh-CN / zh-Hant / en 三个语言目录下的模块 JSON 键集必须完全一致；
 * 2. 同一语言内不允许跨模块重复键（合并时会静默覆盖）；
 * 3. 不允许空值（未翻译占位）。
 * 失败以退出码 1 结束（阻断 typecheck/CI）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n', 'locales');
const BASE = 'zh-CN';
const locales = readdirSync(localesRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

function loadLocale(locale) {
  const dir = join(localesRoot, locale);
  const keys = new Map(); // key -> file
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
      if (typeof v !== 'string' || v.trim() === '') {
        errors.push(`${locale}/${f}: 键 "${k}" 的值为空或非字符串`);
      }
    }
  }
  return { keys, errors };
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
