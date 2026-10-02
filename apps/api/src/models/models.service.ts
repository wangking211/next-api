import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModelOrigin } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TtlCacheService } from '../common/ttl-cache.service';
import { CreateModelDto } from './dto/create-model.dto';
import { UpdateModelDto } from './dto/update-model.dto';
import { COMMON_MODELS } from './common-models';
import { inferVendorOrigin } from './origin.util';

@Injectable()
export class ModelsService {
  constructor(
    private readonly prisma: PrismaService,
    // 网关热路径共享的模型目录快照；测试手工构造时未传 → 仅跳过失效动作
    @Optional() private readonly cache?: TtlCacheService,
  ) {}

  /** 目录写路径：失效网关共享的 `catalog:*` 快照（TTL 兜底：旁路改库 60s 后收敛） */
  private invalidateCatalog() {
    this.cache?.invalidate('catalog:');
  }

  /** 内置主流模型建议（供渠道创建时选择，不依赖数据库种子） */
  suggestions() {
    return COMMON_MODELS;
  }

  list(onlyEnabled = false) {
    return this.prisma.modelCatalog.findMany({
      where: onlyEnabled ? { enabled: true } : {},
      orderBy: [{ provider: 'asc' }, { name: 'asc' }],
    });
  }

  async create(dto: CreateModelDto) {
    const inferred = inferVendorOrigin(dto.name);
    const row = await this.prisma.modelCatalog.create({
      data: {
        name: dto.name,
        displayName: dto.displayName,
        provider: dto.provider,
        origin: dto.origin ?? inferred.origin,
        vendor: dto.vendor ?? inferred.vendor,
        inputPrice: dto.inputPrice ?? 0,
        outputPrice: dto.outputPrice ?? 0,
        cacheReadPrice: dto.cacheReadPrice ?? 0,
        cacheWritePrice: dto.cacheWritePrice ?? 0,
        perCallPrice: dto.perCallPrice ?? null,
        capabilities: dto.capabilities ?? [],
        aliases: dto.aliases ?? [],
        enabled: dto.enabled ?? true,
      },
    });
    this.invalidateCatalog();
    return row;
  }

  /**
   * 一键归类：按模型名批量推断 vendor / origin 并落库（管理员手动触发）。
   * 会覆盖已保存的 origin/vendor，用于历史数据补标。
   */
  async classifyOrigins() {
    const rows = await this.prisma.modelCatalog.findMany({
      select: { id: true, name: true, vendor: true, origin: true },
    });
    let updated = 0;
    const byOrigin: Record<string, number> = { DOMESTIC: 0, OVERSEAS: 0 };
    const byVendor: Record<string, number> = {};
    // 按 (vendor, origin) 分组批量落库：模型种类有限 → 查询数与表规模无关
    const pending = new Map<
      string,
      { vendor: string | null; origin: ModelOrigin; ids: string[] }
    >();
    for (const r of rows) {
      const { vendor, origin } = inferVendorOrigin(r.name);
      byOrigin[origin] = (byOrigin[origin] ?? 0) + 1;
      byVendor[vendor ?? 'unknown'] = (byVendor[vendor ?? 'unknown'] ?? 0) + 1;
      if (r.vendor !== vendor || r.origin !== origin) {
        const key = `${origin}|${vendor ?? ''}`;
        const bucket = pending.get(key) ?? { vendor, origin, ids: [] };
        bucket.ids.push(r.id);
        pending.set(key, bucket);
        updated++;
      }
    }
    for (const { vendor, origin, ids } of pending.values()) {
      // vendor 为 undefined 时 Prisma 跳过该字段（与原逐行 update 语义一致）
      await this.prisma.modelCatalog.updateMany({
        where: { id: { in: ids } },
        data: { vendor, origin },
      });
    }
    if (updated > 0) this.invalidateCatalog();
    return { total: rows.length, updated, byOrigin, byVendor };
  }

  async update(id: string, dto: UpdateModelDto) {
    const exists = await this.prisma.modelCatalog.findUnique({ where: { id } });
    if (!exists)
      throw new NotFoundException({
        code: 'MODEL_NOT_FOUND',
        message: 'Model not found',
      });
    const row = await this.prisma.modelCatalog.update({ where: { id }, data: { ...dto } });
    this.invalidateCatalog();
    return row;
  }

  async remove(id: string) {
    const exists = await this.prisma.modelCatalog.findUnique({ where: { id } });
    if (!exists)
      throw new NotFoundException({
        code: 'MODEL_NOT_FOUND',
        message: 'Model not found',
      });
    await this.prisma.modelCatalog.delete({ where: { id } });
    this.invalidateCatalog();
    return { success: true };
  }
}
