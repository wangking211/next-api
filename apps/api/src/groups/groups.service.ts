import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelOwnerType, ChannelShareMode, ModelGroupStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TtlCacheService } from '../common/ttl-cache.service';
import { CreateGroupDto, UpdateGroupDto } from './dto/group.dto';

/** 分组行缓存键前缀：CRUD 后统一失效 */
const GROUP_CACHE_PREFIX = 'groups:rows';

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
  private readonly rowsTtl: number;

  constructor(
    private readonly prisma: PrismaService,
    // 测试里手工 `new GroupsService(prisma)` 时未传缓存 → 直查（行为不变）
    @Optional() private readonly cache?: TtlCacheService,
    @Optional() config?: ConfigService,
  ) {
    this.rowsTtl = Number(config?.get<string>('GROUP_CACHE_TTL_MS', '60000')) || 60_000;
  }

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
    if (dup && dup.id !== exceptId)
      throw new BadRequestException({
        code: 'GROUP_IDENTIFIER_EXISTS',
        message: `分组标识 "${name}" 已存在`,
        details: { name },
      });
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
    this.invalidateRows();
    return this.toView(created);
  }

  async update(id: string, dto: UpdateGroupDto) {
    const current = await this.prisma.modelGroup.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!current)
      throw new NotFoundException({
        code: 'GROUP_NOT_FOUND',
        message: '分组不存在',
      });
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
          models: models === undefined ? undefined : { set: models.map((name) => ({ name })) },
        },
        select: GROUP_SELECT,
      });
    });
    this.invalidateRows();
    return this.toView(updated);
  }

  /** 删除分组：用户/令牌分组置空，渠道与模型的关联级联清除 */
  async remove(id: string) {
    const g = await this.prisma.modelGroup.findUnique({
      where: { id },
      select: { id: true, isDefault: true },
    });
    if (!g)
      throw new NotFoundException({
        code: 'GROUP_NOT_FOUND',
        message: '分组不存在',
      });
    if (g.isDefault)
      throw new BadRequestException({
        code: 'GROUP_DEFAULT_UNREMOVABLE',
        message: '默认分组不可删除，请先把其它分组设为默认',
      });
    await this.prisma.modelGroup.delete({ where: { id } });
    this.invalidateRows();
    return { success: true };
  }

  /** 分组行写路径：统一失效缓存（未注入缓存时 no-op） */
  private invalidateRows() {
    this.cache?.invalidate(GROUP_CACHE_PREFIX);
  }

  /**
   * 单个分组行（按 id，仅启用）：带缓存，未注入缓存时直查。
   * 缓存包含「不存在」结果（null），避免缺失 id 反复打库。
   */
  private groupById(id: string): Promise<GroupRow | null> {
    const load = () =>
      this.prisma.modelGroup
        .findFirst({
          where: { id, status: ModelGroupStatus.ENABLED },
          select: GROUP_SELECT,
        })
        .catch(() => null);
    if (!this.cache) return load();
    return this.cache.getOrLoad<GroupRow | null>(
      `${GROUP_CACHE_PREFIX}:id:${id}`,
      this.rowsTtl,
      load,
    );
  }

  /** 默认分组行（启用）：带缓存 */
  private defaultGroup(): Promise<GroupRow | null> {
    const load = () =>
      this.prisma.modelGroup
        .findFirst({
          where: { isDefault: true, status: ModelGroupStatus.ENABLED },
          select: GROUP_SELECT,
        })
        .catch(() => null);
    if (!this.cache) return load();
    return this.cache.getOrLoad<GroupRow | null>(
      `${GROUP_CACHE_PREFIX}:default`,
      this.rowsTtl,
      load,
    );
  }

  /** 用户所属分组 id（仅在调用方没直接给时才查一次库） */
  private async userGroupId(userId: string): Promise<string | null> {
    const u = await this.prisma.user
      .findUnique({ where: { id: userId }, select: { groupId: true } })
      .catch(() => null);
    return u?.groupId ?? null;
  }

  /**
   * 解析生效分组。
   * 优先级：令牌指定分组（且启用） > 用户所属分组（且启用） > 默认分组 > 无分组（不限制）。
   *
   * user.groupId：网关侧传入 guard 已加载的全量 User 行（含 groupId）→ 0 次用户查询；
   * 该字段为 undefined（如 JWT AuthUser 未携带）时才回退查库。分组行本身走 TTL 缓存。
   */
  async effectiveGroup(
    user: { id: string; groupId?: string | null },
    keyGroupId?: string | null,
  ): Promise<EffectiveGroup> {
    if (keyGroupId) {
      const g = await this.groupById(keyGroupId);
      if (g) return this.toEffective(g);
    }
    const userGroupId =
      user.groupId !== undefined ? (user.groupId ?? null) : await this.userGroupId(user.id);
    if (userGroupId) {
      const g = await this.groupById(userGroupId);
      if (g) return this.toEffective(g);
    }
    const def = await this.defaultGroup();
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
   * 渠道分组可见性条件：生效分组存在时返回过滤条件（未配分组的渠道视为公共渠道）；
   * 无分组时返回 null（不限制），调用方需回退到「BYOK + 全部平台渠道」。
   * 注意：不要在 OR 数组里放空对象 `{}`——Prisma 归一化后会导致平台渠道被整体过滤。
   */
  channelVisibilityWhere(groupId: string | null): Prisma.ChannelWhereInput | null {
    if (!groupId) return null;
    return {
      OR: [{ groups: { none: {} } }, { groups: { some: { id: groupId } } }],
    };
  }

  /**
   * 完整渠道可见性条件（含共享渠道），resolve() 与 availableModels() 共用：
   * - 自有渠道：仅持有者可见（无论是否上架）
   * - 他人渠道：`shareMode=PUBLIC` 所有人可见；`shareMode=GROUP` 且与本人生效分组一致才可见
   * - 平台渠道：按分组（未配分组的视为公共渠道）
   *
   * ⚠️ 共享分支必须显式限定 `ownerType=USER + shareMode`：分组条件里的
   * `groups: { none: {} }` 会匹配到「未配分组的私有渠道」，直接 OR 进去会
   * 把别人的 BYOK 渠道暴露给所有人。
   */
  channelScopeWhere(userId: string, groupId: string | null): Prisma.ChannelWhereInput {
    const own: Prisma.ChannelWhereInput = {
      ownerType: ChannelOwnerType.USER,
      ownerUserId: userId,
    };
    const publicShared: Prisma.ChannelWhereInput = {
      ownerType: ChannelOwnerType.USER,
      shareMode: ChannelShareMode.PUBLIC,
    };
    if (!groupId) {
      return {
        OR: [own, publicShared, { ownerType: ChannelOwnerType.PLATFORM }],
      };
    }
    const groupCond = this.channelVisibilityWhere(groupId)!;
    return {
      OR: [
        own,
        publicShared,
        // GROUP 共享渠道必须已绑定调用方分组；零绑定不匹配（未绑定 = 仅属主可见，
        // 分组删除级联解绑后渠道不会外泄为公共）——故此分支不能复用含 none 臂的 groupCond。
        {
          AND: [
            { ownerType: ChannelOwnerType.USER, shareMode: ChannelShareMode.GROUP },
            { groups: { some: { id: groupId } } },
          ],
        },
        { AND: [{ ownerType: ChannelOwnerType.PLATFORM }, groupCond] },
      ],
    };
  }
}
