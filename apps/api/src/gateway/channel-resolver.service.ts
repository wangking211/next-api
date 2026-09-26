import { Injectable } from '@nestjs/common';
import { Channel, ChannelOwnerType, ChannelStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ResolvedChannel } from './types';

@Injectable()
export class ChannelResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * 为指定用户 + 模型选择候选渠道。
   * 排序：用户自有 BYOK 渠道优先于平台渠道；同级按 priority 降序、weight 加权随机。
   */
  async resolve(userId: string, model: string): Promise<ResolvedChannel[]> {
    const channels = await this.prisma.channel.findMany({
      where: {
        status: ChannelStatus.ENABLED,
        models: { has: model },
        OR: [
          { ownerType: ChannelOwnerType.USER, ownerUserId: userId },
          { ownerType: ChannelOwnerType.PLATFORM },
        ],
      },
    });

    const candidates: ResolvedChannel[] = [];
    for (const channel of channels) {
      try {
        const apiKey = this.crypto.decrypt(channel.apiKeyEnc);
        if (apiKey) candidates.push({ channel, apiKey });
      } catch {
        // 解密失败的渠道跳过
      }
    }

    const ranked = candidates.map((c) => ({
      c,
      tier: c.channel.ownerType === ChannelOwnerType.USER ? 0 : 1,
      // 指数竞速实现加权随机：weight 越大越可能排前
      race: -Math.log(Math.random() || 1e-9) / Math.max(c.channel.weight, 1),
    }));

    ranked.sort(
      (a, b) =>
        a.tier - b.tier ||
        b.c.channel.priority - a.c.channel.priority ||
        a.race - b.race,
    );

    return ranked.map((r) => r.c);
  }

  supportsAnyModel(userId: string, model: string): Promise<Channel | null> {
    return this.prisma.channel.findFirst({
      where: {
        status: ChannelStatus.ENABLED,
        models: { has: model },
        OR: [
          { ownerType: ChannelOwnerType.USER, ownerUserId: userId },
          { ownerType: ChannelOwnerType.PLATFORM },
        ],
      },
    });
  }

  /** 汇总用户当前可实际调用的模型（自有+平台启用渠道所支持的模型） */
  async availableModels(userId: string): Promise<string[]> {
    const channels = await this.prisma.channel.findMany({
      where: {
        status: ChannelStatus.ENABLED,
        OR: [
          { ownerType: ChannelOwnerType.USER, ownerUserId: userId },
          { ownerType: ChannelOwnerType.PLATFORM },
        ],
      },
      select: { models: true },
    });
    const set = new Set<string>();
    for (const c of channels) for (const m of c.models) set.add(m);
    return [...set].sort();
  }
}
