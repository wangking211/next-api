#!/usr/bin/env node
/**
 * 控制台错误码一致性校验（由 `pnpm --filter @ai-gateway/api typecheck` 调用）：
 * 控制台接口的错误必须带稳定 code（`new XxxException({ code, message })`），
 * 否则前端只能原样回显后端文案——后端中英混写，界面就会中英夹杂。
 *
 * 豁免：
 * - gateway/**：网关（/v1）错误按项目约定保持原文，不参与本地化；
 * - observability/**：指标抓取端点，面向采集器而非控制台 UI；
 * - *.spec.ts：测试。
 *
 * 失败以退出码 1 结束（阻断 typecheck/CI）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const EXEMPT_DIRS = ['gateway', 'observability'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const problems = [];
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).replaceAll('\\', '/');
  if (rel.endsWith('.spec.ts')) continue;
  if (EXEMPT_DIRS.some((d) => rel.startsWith(`${d}/`))) continue;

  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/throw new \w*Exception\((.*)$/);
    if (!m) continue;
    const rest = m[1];
    // 对象写法 `{ code: ... }` 是我们要的；裸文案是 `'...'` / `...`（后者为模板串）
    const plainSingle = /^\s*['"`]/.test(rest);
    const plainMulti = /^\s*$/.test(rest) && /^\s*['"`]/.test(lines[i + 1] ?? '');
    if (plainSingle || plainMulti) {
      problems.push(`${rel}:${i + 1}  ${lines[i].trim().slice(0, 96)}`);
    }
  }
}

if (problems.length) {
  console.error(`错误码校验失败（${problems.length} 处裸文案抛出）：`);
  for (const p of problems.slice(0, 40)) console.error('  - ' + p);
  if (problems.length > 40) console.error(`  …以及另外 ${problems.length - 40} 处`);
  console.error(
    "  改成 new XxxException({ code: 'XXX', message: 原文案 })，并在 web 字典补对应键。",
  );
  process.exit(1);
}
console.log('错误码校验通过：控制台接口错误均携带稳定 code');
