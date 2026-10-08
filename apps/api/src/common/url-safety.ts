import { isIP } from 'net';
import { lookup } from 'dns/promises';

/** baseUrl 指向私网/回环/链路本地等内部地址时抛出 */
export class UnsafeUrlError extends Error {
  /** 稳定错误码：控制台据此换本地化文案（前端 errorMessage 认 code） */
  readonly code: string;
  /** 动态参数（主机名/地址/重定向次数），供 i18n 插值 */
  readonly details?: Record<string, string | number>;

  /** message 保留原文，供 API 消费者与日志使用；code 才是给控制台换语言用的稳定标识 */
  constructor(opts: { code: string; message: string; details?: Record<string, string | number> }) {
    super(opts.message);
    this.code = opts.code;
    this.details = opts.details;
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地 + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // 非法/未知一律视为不安全
}

/**
 * 校验渠道 baseUrl：仅允许 http/https，且主机不得解析到私网/回环/链路本地地址。
 * 注意：这是创建/更新时的校验，无法完全防止 DNS rebinding（需在请求时二次校验）。
 */
export async function assertPublicHttpUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError({
      code: 'URL_UNSAFE_INVALID_URL',
      message: 'baseUrl 不是合法的 URL',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError({
      code: 'URL_UNSAFE_SCHEME',
      message: 'baseUrl 仅支持 http/https',
    });
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host)
    throw new UnsafeUrlError({
      code: 'URL_UNSAFE_NO_HOST',
      message: 'baseUrl 缺少主机名',
    });
  const lowered = host.toLowerCase();
  if (
    lowered === 'localhost' ||
    lowered.endsWith('.localhost') ||
    lowered.endsWith('.local') ||
    lowered.endsWith('.internal') ||
    lowered.endsWith('.lan')
  ) {
    throw new UnsafeUrlError({
      code: 'URL_UNSAFE_INTERNAL_HOST',
      message: 'baseUrl 不允许指向内部主机',
    });
  }

  if (isIP(host)) {
    if (isPrivateIp(host))
      throw new UnsafeUrlError({
        code: 'URL_UNSAFE_PRIVATE_ADDRESS',
        message: 'baseUrl 不允许指向私网/回环地址',
      });
    return;
  }

  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new UnsafeUrlError({
      code: 'URL_UNSAFE_DNS_FAILED',
      message: `baseUrl 主机名无法解析: ${host}`,
      details: { host },
    });
  }
  if (addrs.length === 0)
    throw new UnsafeUrlError({
      code: 'URL_UNSAFE_DNS_FAILED',
      message: `baseUrl 主机名无法解析: ${host}`,
      details: { host },
    });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new UnsafeUrlError({
        code: 'URL_UNSAFE_RESOLVED_PRIVATE',
        message: `baseUrl 解析到私网/回环地址 (${a.address})，已拒绝`,
        details: { address: a.address },
      });
    }
  }
}

/**
 * 是否允许出站目标为私网：非生产（本地开发/e2e 用 mock 上游）或显式 ALLOW_PRIVATE_UPSTREAM=true。
 * 与渠道保存、探测、模型列表拉取共用同一开关，避免两套规则漂移。
 */
export function upstreamAllowsPrivate(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.ALLOW_PRIVATE_UPSTREAM === 'true';
}

/** 请求时复验结果缓存（按 scheme://host，成功/失败都记），窗口内热路径零 DNS 开销 */
const recheckCache = new Map<string, { at: number; err?: UnsafeUrlError }>();
const RECHECK_TTL_MS = 60_000;
const RECHECK_MAX_ENTRIES = 5_000;

/**
 * 出站请求前的 baseUrl 二次校验（防 DNS rebinding）。
 *
 * 保存/更新渠道时已校验过一次，但域名在保存后可能被改解析（注册过期抢注、
 * 内网域名劫持）——请求时必须复验，否则网关会替攻击者访问内网/云元数据地址。
 * 结果按 scheme://host 缓存 60s（失败也缓存）：复验窗口 = rebinding 暴露窗口，
 * 而每次请求的实耗成本只在窗口边缘发生。upstreamAllowsPrivate() 时直接放行。
 * 通过返回；失败抛 UnsafeUrlError（稳定 code 供日志/控制台识别）。
 */
export async function assertChannelUrlSafe(raw: string): Promise<void> {
  if (upstreamAllowsPrivate()) return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError({ code: 'URL_UNSAFE_INVALID_URL', message: 'baseUrl 不是合法的 URL' });
  }
  const key = `${url.protocol}//${url.hostname.toLowerCase()}`;
  const now = Date.now();
  const hit = recheckCache.get(key);
  if (hit && now - hit.at < RECHECK_TTL_MS) {
    if (hit.err) throw hit.err;
    return;
  }
  try {
    await assertPublicHttpUrl(raw);
    if (recheckCache.size >= RECHECK_MAX_ENTRIES) recheckCache.clear();
    recheckCache.set(key, { at: now });
  } catch (e) {
    const err =
      e instanceof UnsafeUrlError
        ? e
        : new UnsafeUrlError({
            code: 'URL_UNSAFE_DNS_FAILED',
            message: (e as Error)?.message ?? String(e),
          });
    if (recheckCache.size >= RECHECK_MAX_ENTRIES) recheckCache.clear();
    recheckCache.set(key, { at: now, err });
    throw err;
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 带 SSRF 防护的出站探测 fetch：`redirect: 'manual'` + 逐跳复验目标地址。
 *
 * 只校验首跳是不够的：攻击者可以让公网 URL 302 到 169.254.169.254（云元数据）等内网地址，
 * 自动跟随重定向会直接绕过校验。这里每一跳都重新 assertPublicHttpUrl，最多 maxRedirects 次。
 *
 * 不重放请求体与跨域头，仅用于 GET 类探测（拉模型列表等）。
 */
export async function safeFetch(
  input: string,
  init: RequestInit = {},
  maxRedirects = 3,
): Promise<Response> {
  let current = input;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!upstreamAllowsPrivate()) await assertPublicHttpUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new UnsafeUrlError({
        code: 'URL_UNSAFE_REDIRECT_UNPARSEABLE',
        message: '上游返回了无法解析的重定向地址',
      });
    }
    if (hop === maxRedirects) {
      throw new UnsafeUrlError({
        code: 'URL_UNSAFE_REDIRECT_LIMIT',
        message: `上游重定向次数超过 ${maxRedirects} 次，已拒绝`,
        details: { count: maxRedirects },
      });
    }
    current = next;
  }
  throw new UnsafeUrlError({
    code: 'URL_UNSAFE_REDIRECT_LIMIT',
    message: `上游重定向次数超过 ${maxRedirects} 次，已拒绝`,
    details: { count: maxRedirects },
  });
}
