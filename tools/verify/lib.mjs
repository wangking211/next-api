/**
 * 巡检脚本公共依赖（tools/verify/*）。
 *
 * 凭据只从环境读取，不写入仓库、不打印到输出（与 scripts/model-audit.mjs 同规范）：
 *   AIGW_BASE_URL   平台地址，默认 https://xiaopuyun.com
 *   AIGW_IDENTIFIER 管理员账号，默认 admin
 *   AIGW_PASSWORD   管理员口令（与 AIGW_TOKEN 二选一）
 *   AIGW_TOKEN      直接提供 accessToken（优先于账号口令）
 */

export const base = (process.env.AIGW_BASE_URL || 'https://xiaopuyun.com').replace(/\/+$/, '');
export const identifier = process.env.AIGW_IDENTIFIER || 'admin';
const password = process.env.AIGW_PASSWORD;
/** 管理员口令（仅进程内使用，不打印）；验收脚本拿它做「还原口令」 */
export const adminPassword = password;
let accessToken = process.env.AIGW_TOKEN?.trim() || null;

/** 统一请求封装：返回 { status, ok, json, text }；json 解析失败时回落为原始文本。token 可按次覆盖 */
export async function api(method, urlPath, { body, timeoutMs = 60000, token } = {}) {
  const useToken = token ?? accessToken;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(useToken ? { authorization: `Bearer ${useToken}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 普通登录（不退出进程）：验收脚本需要反复用「正确/错误口令」做对照 */
export function passwordLogin(id, pw) {
  return api('POST', '/api/auth/login', { body: { identifier: id, password: pw } });
}

/** 取管理员令牌：环境给了 AIGW_TOKEN 就直接用，否则走登录口 */
export async function login() {
  if (accessToken) return accessToken;
  if (!password) {
    console.error('缺少 AIGW_PASSWORD 或 AIGW_TOKEN（管理员凭据），无法继续。');
    process.exit(2);
  }
  const r = await passwordLogin(identifier, password);
  if (!r.ok || !r.json?.accessToken) {
    console.error(`登录失败: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    process.exit(2);
  }
  accessToken = r.json.accessToken;
  return accessToken;
}

/** 列表类接口三种返回形态归一：数组 / { items } / { data } */
export function rows(json) {
  if (Array.isArray(json)) return json;
  return json?.items ?? json?.data ?? [];
}

/** PASS/FAIL 计数器：结束时汇总并返回是否全绿（供 process.exitCode 使用） */
export function checker() {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra) => {
    if (cond) {
      pass += 1;
      console.log(`PASS  ${name}`);
    } else {
      fail += 1;
      console.log(`FAIL  ${name}  -> ${JSON.stringify(extra)}`);
    }
  };
  const done = () => {
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
    return fail === 0;
  };
  return { check, done };
}
