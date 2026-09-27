import { Injectable } from '@nestjs/common';
import { ChannelOwnerType, ChannelStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
 */
@Injectable()
export class PublicService {
  constructor(private readonly prisma: PrismaService) {}

  /** 启用中的模型目录 + provider 列表，供落地页定价表展示 */
  async models(): Promise<{ items: PublicModel[]; providers: string[]; count: number }> {
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
  }

  /** 落地页数据条：模型 / 提供商 / 启用渠道 / 协议覆盖 */
  async stats(): Promise<PublicStats> {
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
  }
}
