import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateModelDto } from './dto/create-model.dto';
import { UpdateModelDto } from './dto/update-model.dto';
import { COMMON_MODELS } from './common-models';

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
    return this.prisma.modelCatalog.create({
      data: {
        name: dto.name,
        displayName: dto.displayName,
        provider: dto.provider,
        inputPrice: dto.inputPrice ?? 0,
        outputPrice: dto.outputPrice ?? 0,
        cacheReadPrice: dto.cacheReadPrice ?? 0,
        cacheWritePrice: dto.cacheWritePrice ?? 0,
        enabled: dto.enabled ?? true,
      },
    });
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
