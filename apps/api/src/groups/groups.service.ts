import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ModelGroupStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateGroupDto, UpdateGroupDto } from './dto/group.dto';

/** 生效分组：令牌分组 > 用户分组 > 默认分组 > 无分组（不限制） */
export interface EffectiveGroup {
  id: string | null;
  name: string;
  /** 分组倍率；null = 不参与（回退用户/代理倍率） */
  ratio: number | null;
  /** 可见模型集合；空数组 = 不限制（全部可见） */
  models: string[];
}

const GROUP_SELECT = {
  id: true,
  name: true,
  displayName: true,
  description: true,
  ratio: true,
  status: true,
  priority: true,
  isDefault: true,
  models: { select: { name: true } },
} satisfies Prisma.ModelGroupSelect;

type GroupRow = Prisma.ModelGroupGetPayload<{ select: typeof GROUP_SELECT }>;

@Injectable()
export class GroupsService {
  constructor(private readonly prisma: PrismaService) {}

  private toView(g: GroupRow & { _count?: Record<string, number> }) {
    return {
      id: g.id,
      name: g.name,
      displayName: g.displayName,
      description: g.description,
      ratio: g.ratio != null ? Number(g.ratio) : null,
      status: g.status,
      priority: g.priority,
      isDefault: g.isDefault,
      models: g.models.map((m) => m.name).sort(),
      counts: g._count,
    };
  }

  async list() {
    const rows = await this.prisma.modelGroup.findMany({
      orderBy: [{ priority: 'desc' }, { name: 'asc' }],
      select: {
        ...GROUP_SELECT,
        _count: { select: { models: true, users: true, apiKeys: true, channels: true } },
      },
    });
    return rows.map((r) => this.toView(r));
  }

  private async assertNameFree(name: string, exceptId?: string) {
    const dup = await this.prisma.modelGroup.findUnique({ where: { name }, select: { id: true } });
    if (dup && dup.id !== exceptId) throw new BadRequestException(`分组标识 "${name}" 已存在`);
  }

  /** 目录中实际存在的模型名（过滤不存在项，避免分组引用脏数据） */
  private async existingModels(names: string[]): Promise<string[]> {
    if (!names.length) return [];
    const uniq = [...new Set(names)];
    const rows = await this.prisma.modelCatalog.findMany({
      where: { name: { in: uniq } },
      select: { name: true },
    });
    return rows.map((r) => r.name);
  }

  async create(dto: CreateGroupDto) {
    await this.assertNameFree(dto.name);
    const models = dto.models?.length ? await this.existingModels(dto.models) : [];
    const created = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.modelGroup.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      }
      return tx.modelGroup.create({
        data: {
          name: dto.name,
          displayName: dto.displayName,
          description: dto.description ?? null,
          ratio: dto.ratio ?? null,
          status: dto.status ?? ModelGroupStatus.ENABLED,
          priority: dto.priority ?? 0,
          isDefault: dto.isDefault ?? false,
          models: models.length ? { connect: models.map((name) => ({ name })) } : undefined,
        },
        select: GROUP_SELECT,
      });
    });
    return this.toView(created);
  }

  async update(id: string, dto: UpdateGroupDto) {
    const current = await this.prisma.modelGroup.findUnique({ where: { id }, select: { id: true } });
    if (!current) throw new NotFoundException('分组不存在');
    const models =
      dto.models === undefined
        ? undefined
        : dto.models.length
          ? await this.existingModels(dto.models)
          : [];
    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.modelGroup.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.modelGroup.update({
        where: { id },
        data: {
          displayName: dto.displayName,
          description: dto.description,
          ratio: dto.ratio === undefined ? undefined : dto.ratio,
          status: dto.status,
          priority: dto.priority,
          isDefault: dto.isDefault,
          models:
            models === undefined
              ? undefined
              : { set: models.map((name) => ({ name })) },
        },
        select: GROUP_SELECT,
      });
    });
    return this.toView(updated);
  }

  /** 删除分组：用户/令牌分组置空，渠道与模型的关联级联清除 */
  async remove(id: string) {
    const g = await this.prisma.modelGroup.findUnique({ where: { id }, select: { id: true, isDefault: true } });
    if (!g) throw new NotFoundException('分组不存在');
    if (g.isDefault) throw new BadRequestException('默认分组不可删除，请先把其它分组设为默认');
    await this.prisma.modelGroup.delete({ where: { id } });
    return { success: true };
  }

  /**
   * 解析生效分组。
   * 优先级：令牌指定分组（且启用） > 用户所属分组（且启用） > 默认分组 > 无分组（不限制）。
   */
  async effectiveGroup(userId: string, keyGroupId?: string | null): Promise<EffectiveGroup> {
    if (keyGroupId) {
      const g = await this.prisma.modelGroup.findFirst({
        where: { id: keyGroupId, status: ModelGroupStatus.ENABLED },
        select: GROUP_SELECT,
      });
      if (g) return this.toEffective(g);
    }
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { groupId: true },
    });
    if (u?.groupId) {
      const g = await this.prisma.modelGroup.findFirst({
        where: { id: u.groupId, status: ModelGroupStatus.ENABLED },
        select: GROUP_SELECT,
      });
      if (g) return this.toEffective(g);
    }
    const def = await this.prisma.modelGroup.findFirst({
      where: { isDefault: true, status: ModelGroupStatus.ENABLED },
      select: GROUP_SELECT,
    });
    if (def) return this.toEffective(def);
    return { id: null, name: 'default', ratio: null, models: [] };
  }

  private toEffective(g: GroupRow): EffectiveGroup {
    return {
      id: g.id,
      name: g.name,
      ratio: g.ratio != null ? Number(g.ratio) : null,
      models: g.models.map((m) => m.name),
    };
  }

  /** 模型对该分组是否可见（分组未配置可见模型 = 不限制） */
  isModelVisible(group: EffectiveGroup, model: string): boolean {
    return group.models.length === 0 || group.models.includes(model);
  }

  /**
   * 渠道可见性过滤条件：未配分组的渠道为公共渠道；配了分组的渠道仅对同分组可见。
   * groupId 为 null（系统无分组）时不限制，保证兼容。
   */
  channelVisibilityWhere(groupId: string | null): Prisma.ChannelWhereInput {
    if (!groupId) return {};
    return {
      OR: [{ groups: { none: {} } }, { groups: { some: { id: groupId } } }],
    };
  }
}
