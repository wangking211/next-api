import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateModelDto } from './dto/create-model.dto';
import { UpdateModelDto } from './dto/update-model.dto';
import { COMMON_MODELS } from './common-models';
import { inferVendorOrigin } from './origin.util';

@Injectable()
export class ModelsService {
  constructor(private readonly prisma: PrismaService) {}

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

  create(dto: CreateModelDto) {
    const inferred = inferVendorOrigin(dto.name);
    return this.prisma.modelCatalog.create({
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
    for (const r of rows) {
      const { vendor, origin } = inferVendorOrigin(r.name);
      byOrigin[origin] = (byOrigin[origin] ?? 0) + 1;
      byVendor[vendor ?? 'unknown'] = (byVendor[vendor ?? 'unknown'] ?? 0) + 1;
      if (r.vendor !== vendor || r.origin !== origin) {
        await this.prisma.modelCatalog.update({
          where: { id: r.id },
          data: { vendor, origin },
        });
        updated++;
      }
    }
    return { total: rows.length, updated, byOrigin, byVendor };
  }

  async update(id: string, dto: UpdateModelDto) {
    const exists = await this.prisma.modelCatalog.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Model not found');
    return this.prisma.modelCatalog.update({ where: { id }, data: { ...dto } });
  }

  async remove(id: string) {
    const exists = await this.prisma.modelCatalog.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Model not found');
    await this.prisma.modelCatalog.delete({ where: { id } });
    return { success: true };
  }
}
