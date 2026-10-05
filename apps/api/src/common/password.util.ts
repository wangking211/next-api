import * as bcrypt from 'bcryptjs';

/**
 * 密码哈希轮数。
 *
 * 注册、用户自助找回密码、管理员重置密码三条链路必须用同一个值：
 * 轮数写进哈希串本身，登录时 `bcrypt.compare` 能自动适配不同轮数，
 * 但散落多处常量迟早会漂移，统一收在这里。
 */
export const BCRYPT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}
