import { randomBytes } from 'crypto';

/** 公开的占位符/默认值：任何环境都不得用于签发 JWT */
const INSECURE_PLACEHOLDERS = new Set([
  'change-me',
  'change-me-in-production',
  '',
]);

/** 生产环境 JWT_SECRET 最小长度（字符） */
export const MIN_PROD_JWT_SECRET_LENGTH = 32;

/**
 * 校验生产环境 JWT 密钥：拒绝占位符、过短与低熵（单一重复字符）取值。
 * 校验失败抛错 → 进程启动失败（fail-fast），绝不带弱密钥上线。
 */
export function assertProdJwtSecret(value: string): void {
  const v = (value ?? '').trim();
  const problems: string[] = [];
  if (INSECURE_PLACEHOLDERS.has(v)) {
    problems.push('不得使用公开占位符（change-me 等）');
  } else if (v.length < MIN_PROD_JWT_SECRET_LENGTH) {
    problems.push(`长度至少 ${MIN_PROD_JWT_SECRET_LENGTH} 字符`);
  } else if (/^(.)\1+$/.test(v)) {
    problems.push('熵不足（单一重复字符）');
  }
  if (problems.length) {
    throw new Error(`JWT_SECRET 不安全：${problems.join('；')}`);
  }
}

/**
 * 解析 JWT 签名密钥（JwtModule 使用）：
 * - production：强制通过 assertProdJwtSecret，不安全即启动失败（不再有 change-me 回退）；
 * - 非生产：缺失或不安全时生成一次性随机密钥（重启后会话失效），
 *   避免开发/测试环境用公开字符串签发、被伪造任意用户。
 */
export function resolveJwtSecret(raw: string | undefined, isProd: boolean): string {
  const value = (raw ?? '').trim();
  if (isProd) {
    assertProdJwtSecret(value);
    return value;
  }
  if (INSECURE_PLACEHOLDERS.has(value) || value.length < 16) {
    return randomBytes(32).toString('hex');
  }
  return value;
}
