import { isIP } from 'net';
import { lookup } from 'dns/promises';

/** baseUrl 指向私网/回环/链路本地等内部地址时抛出 */
export class UnsafeUrlError extends Error {}

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
    throw new UnsafeUrlError('baseUrl 不是合法的 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('baseUrl 仅支持 http/https');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new UnsafeUrlError('baseUrl 缺少主机名');
  const lowered = host.toLowerCase();
  if (
    lowered === 'localhost' ||
    lowered.endsWith('.localhost') ||
    lowered.endsWith('.local') ||
    lowered.endsWith('.internal') ||
    lowered.endsWith('.lan')
  ) {
    throw new UnsafeUrlError('baseUrl 不允许指向内部主机');
  }

  if (isIP(host)) {
    if (isPrivateIp(host)) throw new UnsafeUrlError('baseUrl 不允许指向私网/回环地址');
    return;
  }

  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new UnsafeUrlError(`baseUrl 主机名无法解析: ${host}`);
  }
  if (addrs.length === 0) throw new UnsafeUrlError(`baseUrl 主机名无法解析: ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new UnsafeUrlError(`baseUrl 解析到私网/回环地址 (${a.address})，已拒绝`);
    }
  }
}
