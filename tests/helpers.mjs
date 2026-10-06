/**
 * e2e 共享工具：断言计数、控制台 API 请求、网关对话请求、轮询等待。
 *
 * 抽取原因：6 个测试脚本各自复制一份 check/api/chat，改一处要同步六处
 * （落账等待 until 就被复制过两份）。此处语义与各脚本原实现逐行等价。
 */
export const API = 'http://localhost:3000';

let pass = 0;
let fail = 0;

/** 记一条断言并打印 PASS / FAIL（FAIL 附带观测值） */
export function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}  -> ${JSON.stringify(extra)}`);
  }
}

/** 控制台接口请求：返回 { status, data }；响应体非 JSON 时 data 为 null */
export async function api(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, data };
}

/** 网关对话请求（返回 Response，由调用方读 status/text/json） */
export const chat = (sk, body) =>
  fetch(API + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sk}` },
    body: JSON.stringify(body),
  });

/**
 * 轮询到条件成立（或超时返回 false）。
 *
 * 落账在响应写出之后后台完成（settleInBackground），读侧断言必须等它落地；
 * 条件轮询而非固定 sleep——慢 CI 上也稳定，超时则由随后的 check 按原样失败。
 */
export async function until(cond, timeoutMs = 5000, stepMs = 100) {
  const start = Date.now();
  for (;;) {
    if (await cond()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** 打印汇总并按失败数退出（0 = 全过） */
export function finish() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
