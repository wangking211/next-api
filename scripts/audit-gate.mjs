// CI 安全门：解析 pnpm audit --json 报告。
// 判定：prod critical 阻塞（exit 1）；high 只报告不阻塞；其余仅信息输出。
// 用法：node scripts/audit-gate.mjs <audit.json>
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/audit-gate.mjs <audit.json>');
  process.exit(2);
}

let raw;
try {
  raw = readFileSync(file, 'utf8').trim();
} catch {
  console.error(`audit-gate: cannot read ${file}`);
  process.exit(2);
}

// 零漏洞时 pnpm audit --json 可能输出空串
let data = {};
if (raw) {
  try {
    data = JSON.parse(raw);
  } catch {
    console.error('audit-gate: invalid JSON in audit report');
    process.exit(2);
  }
}

const v = data?.metadata?.vulnerabilities ?? {};
const critical = v.critical ?? 0;
const high = v.high ?? 0;
const moderate = v.moderate ?? 0;
const low = v.low ?? 0;
console.log(`prod audit: critical=${critical} high=${high} moderate=${moderate} low=${low}`);

const advisories = Object.values(data?.advisories ?? {});
for (const a of advisories) {
  if (a.severity === 'critical' || a.severity === 'high') {
    console.log(
      `- ${a.severity}: ${a.module_name} ${a.vulnerable_versions} | ${a.title} | patched: ${a.patched_versions}`,
    );
  }
}

if (critical > 0) {
  console.error(`FAIL: ${critical} critical production vulnerabilities`);
  process.exit(1);
}
if (high > 0) {
  console.warn(`WARN: ${high} high production vulnerabilities (reported, non-blocking)`);
}
console.log('audit-gate: PASS');
