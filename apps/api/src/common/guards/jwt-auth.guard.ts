import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, JwtPayload } from '../interfaces/auth.interface';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const auth: string | undefined = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_MISSING',
        message: 'Missing bearer token',
      });
    }
    const token = auth.slice('Bearer '.length).trim();

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_INVALID',
        message: 'Invalid or expired token',
      });
    }

    // 回查数据库：用户被封禁/删除/降权/被强制下线即时生效，而非等 7 天 token 过期
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        status: true,
        tokenVersion: true,
      },
    });
    if (!user)
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_INVALID',
        message: 'Invalid or expired token',
      });
    if (user.status === UserStatus.BANNED) {
      throw new UnauthorizedException({
        code: 'AUTH_ACCOUNT_BANNED',
        message: 'Account is banned',
      });
    }
    // 令牌吊销：tokenVersion 已自增（退出全部设备/强制下线），旧 token 一律拒绝
    if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_REVOKED',
        message: 'Token revoked',
      });
    }

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };
    req.user = authUser;
    return true;
  }
}
