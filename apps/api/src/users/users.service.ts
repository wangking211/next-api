import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

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

  async list(query?: string, page = 1, pageSize = 20, role?: Role) {
    const where: Prisma.UserWhereInput = {
      ...(role ? { role } : {}),
      ...(query
        ? {
            OR: [
              { email: { contains: query, mode: 'insensitive' as const } },
              { username: { contains: query, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
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
          createdAt: true,
          _count: { select: { apiKeys: true, channels: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /** 管理员：更新用户角色/售价倍率/归属代理（可清空倍率与代理） */
  async updateUser(
    id: string,
    data: {
      role?: Role;
      priceMultiplier?: number | null;
      agentId?: string | null;
      rebateRate?: number | null;
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
      },
    });
  }
}

export type UserWithCounts = Prisma.UserGetPayload<{
  include: { _count: { select: { apiKeys: true; channels: true } } };
}>;
