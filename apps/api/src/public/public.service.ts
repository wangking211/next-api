import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelOwnerType, ChannelStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TtlCacheService } from '../common/ttl-cache.service';

export interface PublicModel {
  name: string;
  displayName: string;
  provider: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  cacheWritePrice: number;
}

export interface PublicStats {
  modelCount: number;
  providerCount: number;
  channelCount: number;
  protocolCount: number;
  protocols: string[];
}

/**
 * 面向未登录访问者的公开数据（落地页 / 登录页使用）。
 * 只暴露模型目录的定价字段与聚合计数，不泄露渠道地址、密钥、用户数据。
 *
 * 未登录访问会随落地页被频繁拉取 → 结果做短 TTL memo（默认 30s）。
 * key 落在 `catalog:` 命名空间下，模型目录写路径（models.service）会一并失效。
 */
@Injectable()
export class PublicService {
  private readonly ttl: number;

  constructor(
    private readonly prisma: PrismaService,
    // 测试手工构造时未传缓存 → 直查（行为不变）
    @Optional() private readonly cache?: TtlCacheService,
    @Optional() config?: ConfigService,
  ) {
    this.ttl = Number(config?.get<string>('PUBLIC_CACHE_TTL_MS', '30000')) || 30_000;
  }

  private memo<T>(key: string, loader: () => Promise<T>): Promise<T> {
    if (!this.cache) return loader();
    return this.cache.getOrLoad(key, this.ttl, loader);
  }

  /** 启用中的模型目录 + provider 列表，供落地页定价表展示 */
  models(): Promise<{ items: PublicModel[]; providers: string[]; count: number }> {
    return this.memo('catalog:public:models', async () => {
      const rows = await this.prisma.modelCatalog.findMany({
        where: { enabled: true },
        select: {
          name: true,
          displayName: true,
          provider: true,
          inputPrice: true,
          outputPrice: true,
          cacheReadPrice: true,
          cacheWritePrice: true,
        },
        orderBy: [{ provider: 'asc' }, { name: 'asc' }],
      });

      const items: PublicModel[] = rows.map((r) => ({
        name: r.name,
        displayName: r.displayName,
        provider: r.provider,
        inputPrice: Number(r.inputPrice),
        outputPrice: Number(r.outputPrice),
        cacheReadPrice: Number(r.cacheReadPrice),
        cacheWritePrice: Number(r.cacheWritePrice),
      }));

      const providers = [...new Set(items.map((i) => i.provider))];
      return { items, providers, count: items.length };
    });
  }

  /** 落地页数据条：模型 / 提供商 / 启用渠道 / 协议覆盖 */
  stats(): Promise<PublicStats> {
    return this.memo('catalog:public:stats', async () => {
      const [modelCount, providerRows, channelCount] = await Promise.all([
        this.prisma.modelCatalog.count({ where: { enabled: true } }),
        this.prisma.modelCatalog.findMany({
          where: { enabled: true },
          distinct: ['provider'],
          select: { provider: true },
        }),
        this.prisma.channel.count({
          where: { status: ChannelStatus.ENABLED, ownerType: ChannelOwnerType.PLATFORM },
        }),
      ]);

      const protocols = ['openai', 'anthropic', 'gemini'];
      return {
        modelCount,
        providerCount: providerRows.length,
        channelCount,
        protocolCount: protocols.length,
        protocols,
      };
    });
  }
}
