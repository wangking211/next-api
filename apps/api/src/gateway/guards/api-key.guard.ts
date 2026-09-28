import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyStatus, UserStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../../common/crypto.service';
import { RateLimiterService } from '../rate-limiter.service';
import { ChannelResolverService } from '../channel-resolver.service';
import { toAnthropicErrorBody } from '../anthropic-format';
import { openaiError } from '../types';
import { estimatePromptTokens } from '../../usage/token.util';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly rateLimiter: RateLimiterService,
    private readonly resolver: ChannelResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const apiFormat: 'openai' | 'anthropic' = String(req.path ?? '').includes(
      '/v1/messages',
    )
      ? 'anthropic'
      : 'openai';
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

    // 模型白名单：仅当 Key 配置了 models 且请求带 model 时校验（字面命中 0 查询）
    const requested = typeof req.body?.model === 'string' ? req.body.model : '';
    if (apiKey.models.length > 0 && requested) {
      const allowed = await this.resolver.isModelAllowed(requested, apiKey.models);
      if (!allowed) {
        throw new HttpException(
          apiFormat === 'anthropic'
            ? toAnthropicErrorBody(
                `Model "${requested}" is not allowed for this API key`,
                'permission_error',
              )
            : openaiError(
                `Model "${requested}" is not allowed for this API key`,
                'permission_error',
                'model_not_allowed',
              ),
          403,
        );
      }
    }

    req.gateway = { user: apiKey.user, apiKey };
    await this.rateLimiter.check(apiKey.id, apiKey.rpmLimit, apiFormat);

    // TPM 预扣：按预估 token 数先占额度，响应结束时按实际用量多退少补
    if (apiKey.tpmLimit != null && apiKey.tpmLimit > 0) {
      const estimate = estimatePromptTokens(req.body ?? {});
      const bucket = await this.rateLimiter.checkTpm(
        apiKey.id,
        apiKey.tpmLimit,
        estimate,
        apiFormat,
      );
      if (bucket != null) {
        req.gateway.tpm = { bucket, estimate, actual: 0 };
        const settle = () => {
          const tpm = req.gateway?.tpm;
          if (!tpm || tpm.settled) return;
          tpm.settled = true;
          const delta = (tpm.actual ?? 0) - tpm.estimate;
          if (delta !== 0) void this.rateLimiter.adjustTpm(apiKey.id, tpm.bucket, delta);
        };
        // 只听 finish：中止/异常路径未回填 actual → 按 0 结算全额回滚预估，TTL 兜底
        res.once('finish', settle);
        res.once('close', settle);
      }
    }
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
