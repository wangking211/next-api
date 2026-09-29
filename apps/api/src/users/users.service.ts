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

  /**
   * 用户列表（管理员）：关键词 + 角色/状态/分组/代理/余额区间/注册时间区间 + 排序。
   * 所有筛选项均为可选，未提供即不过滤。
   */
  async list(f: UserListFilters = {}) {
    const page = f.page ?? 1;
    const pageSize = f.pageSize ?? 20;
    const where: Prisma.UserWhereInput = {
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
      ...(f.q
        ? {
            OR: [
              { email: { contains: f.q, mode: 'insensitive' as const } },
              { username: { contains: f.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
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
    return { items, total, page, pageSize };
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
