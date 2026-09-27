import { Injectable } from '@nestjs/common';
import { ChannelOwnerType, ChannelStatus } from '@prisma/client';
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
   * 排序：用户自有 BYOK 优先于平台；同级按 priority 降序、上游成本升序（利润最大）、weight 加权随机。
   * 可用性以 ChannelModel 为准（同一模型可由多渠道提供）。
   */
  async resolve(userId: string, model: string): Promise<ResolvedChannel[]> {
    const [rows, catalog] = await Promise.all([
      this.prisma.channelModel.findMany({
        where: {
          modelName: model,
          enabled: true,
          channel: {
            status: ChannelStatus.ENABLED,
            OR: [
              { ownerType: ChannelOwnerType.USER, ownerUserId: userId },
              { ownerType: ChannelOwnerType.PLATFORM },
            ],
          },
        },
        include: { channel: true },
      }),
      this.prisma.modelCatalog.findUnique({
        where: { name: model },
        select: { inputPrice: true },
      }),
    ]);
    const officialIn = catalog ? Number(catalog.inputPrice) : 0;

    const ranked: {
      c: ResolvedChannel;
      tier: number;
      priority: number;
      cost: number;
      race: number;
    }[] = [];

    for (const cm of rows) {
      let apiKey: string;
      try {
        apiKey = this.crypto.decrypt(cm.channel.apiKeyEnc);
      } catch {
        continue; // 解密失败的渠道跳过
      }
      if (!apiKey) continue;
      const weight = Math.max(cm.weight ?? cm.channel.weight, 1);
      // 路由成本 = 绝对成本 > 官方价 × 上游折扣；无有效成本则排最后
      const rawCost =
        cm.costInput != null
          ? Number(cm.costInput)
          : officialIn * (cm.costDiscount != null ? Number(cm.costDiscount) : 1);
      ranked.push({
        c: { channel: cm.channel, apiKey },
        tier: cm.channel.ownerType === ChannelOwnerType.USER ? 0 : 1,
        priority: cm.priority ?? cm.channel.priority,
        cost: rawCost > 0 ? rawCost : Number.POSITIVE_INFINITY,
        // 指数竞速实现加权随机：weight 越大越可能排前
        race: -Math.log(Math.random() || 1e-9) / weight,
      });
    }

    ranked.sort(
      (a, b) =>
        a.tier - b.tier ||
        b.priority - a.priority ||
        a.cost - b.cost ||
        a.race - b.race,
    );

    return ranked.map((r) => r.c);
  }

  supportsAnyModel(userId: string, model: string): Promise<unknown> {
    return this.prisma.channelModel.findFirst({
      where: {
        modelName: model,
        enabled: true,
        channel: {
          status: ChannelStatus.ENABLED,
          OR: [
            { ownerType: ChannelOwnerType.USER, ownerUserId: userId },
            { ownerType: ChannelOwnerType.PLATFORM },
          ],
        },
      },
    });
  }

  /** 汇总用户当前可实际调用的模型（自有+平台启用渠道所支持的模型） */
  async availableModels(userId: string): Promise<string[]> {
    const rows = await this.prisma.channelModel.findMany({
      where: {
        enabled: true,
        channel: {
          status: ChannelStatus.ENABLED,
          OR: [
            { ownerType: ChannelOwnerType.USER, ownerUserId: userId },
            { ownerType: ChannelOwnerType.PLATFORM },
          ],
        },
      },
      distinct: ['modelName'],
      select: { modelName: true },
    });
    return rows.map((r) => r.modelName).sort();
  }
}
