import { Role } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  email: string;
  username: string;
  role: Role;
  /** 令牌版本：与 User.tokenVersion 不一致即视为已吊销（退出全部设备/强制下线） */
  tv?: number;
}

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  role: Role;
}
