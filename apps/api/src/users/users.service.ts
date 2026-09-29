import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, User, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** 用户列表筛选项（全部可选，未提供即不过滤） */
export interface UserListFilters {
  q?: string;
  page?: number;
  pageSize?: number;
  role?: Role;
  status?: UserStatus;
  groupId?: string;
  agentId?: string;
  /** 余额区间（USD） */
  balanceMin?: number;
  balanceMax?: number;
  /** 注册时间区间 */
  createdFrom?: Date;
  createdTo?: Date;
  /** 有无 Key / 有无渠道 */
  hasKeys?: boolean;
  hasChannels?: boolean;
  sortBy?: 'createdAt' | 'balance' | 'username';
  sortOrder?: 'asc' | 'desc';
}

@Injectable()
export class UsersService {  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { username } });
  }

  findByEmailOrUsername(identifier: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { username: identifier }] },
    });
  }

  create(data: {
    email: string;
    username: string;
    passwordHash: string;
    role?: Role;
  }): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: data.email,
        username: data.username,
        passwordHash: data.passwordHash,
        role: data.role ?? Role.USER,
      },
    });
  }

  async getOrThrow(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  delete(id: string): Promise<User> {
    return this.prisma.user.delete({ where: { id } });
  }

  /** 由筛选项构造 Prisma where（list 与 CSV 导出共用） */
  private buildWhere(f: UserListFilters): Prisma.UserWhereInput {
    return {
      ...(f.role ? { role: f.role } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.groupId ? { groupId: f.groupId } : {}),
      ...(f.agentId ? { agentId: f.agentId } : {}),
      ...(f.balanceMin != null || f.balanceMax != null
        ? {
            balance: {
              ...(f.balanceMin != null ? { gte: f.balanceMin } : {}),
              ...(f.balanceMax != null ? { lte: f.balanceMax } : {}),
            },
          }
        : {}),
      ...(f.createdFrom || f.createdTo
        ? {
            createdAt: {
              ...(f.createdFrom ? { gte: f.createdFrom } : {}),
              ...(f.createdTo ? { lte: f.createdTo } : {}),
            },
          }
        : {}),
      ...(f.hasKeys === true
        ? { apiKeys: { some: {} } }
        : f.hasKeys === false
          ? { apiKeys: { none: {} } }
          : {}),
      ...(f.hasChannels === true
        ? { channels: { some: {} } }
        : f.hasChannels === false
          ? { channels: { none: {} } }
          : {}),
      ...(f.q
        ? {
            OR: [
              { email: { contains: f.q, mode: 'insensitive' as const } },
              { username: { contains: f.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
  }

  /**
   * 用户列表（管理员）：关键词 + 角色/状态/分组/代理/余额区间/注册时间区间 + 有无 Key/渠道 + 排序。
   * 所有筛选项均为可选，未提供即不过滤。
   */
  async list(f: UserListFilters = {}) {
    const page = f.page ?? 1;
    const pageSize = f.pageSize ?? 20;
    const where = this.buildWhere(f);
    const sortBy = f.sortBy ?? 'createdAt';
    const sortOrder = f.sortOrder ?? 'desc';
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          status: true,
          balance: true,
          priceMultiplier: true,
          rebateRate: true,
          agentId: true,
          agent: { select: { id: true, username: true, priceMultiplier: true } },
          groupId: true,
          group: { select: { id: true, name: true, displayName: true, ratio: true } },
          createdAt: true,
          _count: { select: { apiKeys: true, channels: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    const lastActive = await this.lastActiveMap(items.map((u) => u.id));
    return {
      items: items.map((u) => ({ ...u, lastActiveAt: lastActive.get(u.id) ?? null })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 派生「最后活跃时间」：取该批用户在 RequestLog 中的最近一次调用时刻。
   * 走 (userId, createdAt) 索引聚合，避免为 User 增加冗余列与写放大。
   */
  private async lastActiveMap(userIds: string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (!userIds.length) return out;
    try {
      const rows = await this.prisma.requestLog.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds } },
        _max: { createdAt: true },
      });
      for (const r of rows) {
        if (r._max.createdAt) out.set(r.userId, r._max.createdAt);
      }
    } catch {
      // 聚合失败不影响列表主流程
    }
    return out;
  }

  /** 按当前筛选导出用户 CSV（上限 1 万行，含派生最后活跃时间） */
  async exportCsv(f: UserListFilters = {}): Promise<{ csv: string; count: number }> {
    const { page: _p, pageSize: _ps, ...rest } = f;
    const where = this.buildWhere(rest);
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: { [f.sortBy ?? 'createdAt']: f.sortOrder ?? 'desc' },
      take: 10000,
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        status: true,
        balance: true,
        priceMultiplier: true,
        rebateRate: true,
        createdAt: true,
        agent: { select: { username: true } },
        group: { select: { name: true } },
        _count: { select: { apiKeys: true, channels: true } },
      },
    });
    const lastActive = await this.lastActiveMap(rows.map((r) => r.id));
    const esc = (v: unknown): string => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      'id',
      'email',
      'username',
      'role',
      'status',
      'balance',
      'priceMultiplier',
      'agent',
      'group',
      'apiKeyCount',
      'channelCount',
      'lastActiveAt',
      'createdAt',
    ].join(',');
    const lines = rows.map((r) =>
      [
        r.id,
        r.email,
        r.username,
        r.role,
        r.status,
        Math.round(Number(r.balance) * 1e6) / 1e6,
        r.priceMultiplier != null ? Number(r.priceMultiplier) : '',
        r.agent?.username ?? '',
        r.group?.name ?? '',
        r._count.apiKeys,
        r._count.channels,
        lastActive.get(r.id)?.toISOString() ?? '',
        r.createdAt.toISOString(),
      ]
        .map(esc)
        .join(','),
    );
    return { csv: [header, ...lines].join('\n'), count: rows.length };
  }

  /** 管理员：更新用户角色/售价倍率/归属代理/所属分组（可清空倍率与代理） */
  async updateUser(
    id: string,
    data: {
      role?: Role;
      priceMultiplier?: number | null;
      agentId?: string | null;
      rebateRate?: number | null;
      groupId?: string | null;
    },
  ) {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return this.prisma.user.update({
      where: { id },
      data: {
        ...(data.role !== undefined ? { role: data.role } : {}),
        ...(data.priceMultiplier !== undefined
          ? { priceMultiplier: data.priceMultiplier }
          : {}),
        ...(data.agentId !== undefined ? { agentId: data.agentId } : {}),
        ...(data.rebateRate !== undefined ? { rebateRate: data.rebateRate } : {}),
        ...(data.groupId !== undefined ? { groupId: data.groupId } : {}),
      },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        status: true,
        balance: true,
        priceMultiplier: true,
        rebateRate: true,
        agentId: true,
        groupId: true,
        group: { select: { id: true, name: true, displayName: true, ratio: true } },
      },
    });
  }
}

export type UserWithCounts = Prisma.UserGetPayload<{
  include: { _count: { select: { apiKeys: true; channels: true } } };
}>;
