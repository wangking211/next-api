import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyStatus, UserStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../../common/crypto.service';
import { RateLimiterService } from '../rate-limiter.service';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const token = this.extractToken(req);
    if (!token) {
      throw new UnauthorizedException(
        'Missing API key. Pass it via "Authorization: Bearer sk-..." or "x-api-key".',
      );
    }

    const keyHash = this.crypto.hashApiKey(token);
    let apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      include: { user: true },
    });

    // 兼容 pepper 启用前签发的旧 Key：旧哈希命中后自动升级为 HMAC 哈希
    if (!apiKey && this.crypto.apiKeyHashingEnabled) {
      const legacyHash = this.crypto.legacyHashApiKey(token);
      const legacy = await this.prisma.apiKey.findUnique({
        where: { keyHash: legacyHash },
        include: { user: true },
      });
      if (legacy) {
        apiKey = legacy;
        try {
          await this.prisma.apiKey.update({
            where: { id: legacy.id },
            data: { keyHash },
          });
        } catch {
          // 升级失败（如唯一冲突）不阻断请求，下次访问再试
        }
      }
    }

    if (!apiKey) throw new UnauthorizedException('Invalid API key');

    if (apiKey.status !== ApiKeyStatus.ACTIVE) {
      throw new ForbiddenException(`API key is ${apiKey.status.toLowerCase()}`);
    }
    if (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('API key has expired');
    }
    if (apiKey.user.status === UserStatus.BANNED) {
      throw new ForbiddenException('Account is banned');
    }
    if (apiKey.quotaLimit != null && apiKey.quotaUsed >= apiKey.quotaLimit) {
      throw new ForbiddenException('API key token quota exhausted');
    }
    if (
      apiKey.costLimit != null &&
      Number(apiKey.costUsed) >= Number(apiKey.costLimit)
    ) {
      throw new ForbiddenException('API key cost quota exhausted');
    }

    req.gateway = { user: apiKey.user, apiKey };
    await this.rateLimiter.check(apiKey.id, apiKey.rpmLimit);
    return true;
  }

  private extractToken(req: any): string | null {
    const auth: string | undefined = req.headers['authorization'];
    if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
    const xKey = req.headers['x-api-key'];
    if (typeof xKey === 'string' && xKey) return xKey.trim();
    return null;
  }
}
