import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BalanceTxType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMemberDto } from './dto/create-member.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

@Injectable()
export class AgentService {
  constructor(private readonly prisma: PrismaService) {}

  /** 代理概览：余额、返点比例/倍率、名下成员数与近 30 天成员消费、累计返点 */
  async overview(agentId: string) {
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [user, memberCount, commissionAgg, members] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: agentId },
        select: { balance: true, rebateRate: true, priceMultiplier: true },
      }),
      this.prisma.user.count({ where: { agentId } }),
      this.prisma.balanceTransaction.aggregate({
        where: { userId: agentId, type: BalanceTxType.COMMISSION },
        _sum: { amount: true },
      }),
      this.prisma.user.findMany({ where: { agentId }, select: { id: true } }),
    ]);

    const ids = members.map((m) => m.id);
    // 请求/token 计全部调用（BYOK 也是真实用量），消费只计实际扣费
    const [usage, billed] = ids.length
      ? await Promise.all([
          this.prisma.requestLog.aggregate({
            where: { userId: { in: ids }, createdAt: { gte: since } },
            _count: { _all: true },
            _sum: { totalTokens: true },
          }),
          this.prisma.requestLog.aggregate({
            where: { userId: { in: ids }, createdAt: { gte: since }, chargeable: true },
            _sum: { cost: true },
          }),
        ])
      : [null, null];

    return {
      balance: user ? Number(user.balance) : 0,
      rebateRate: user?.rebateRate != null ? Number(user.rebateRate) : null,
      priceMultiplier:
        user?.priceMultiplier != null ? Number(user.priceMultiplier) : null,
      memberCount,
      commissionTotal: commissionAgg._sum.amount
        ? Number(commissionAgg._sum.amount)
        : 0,
      membersUsage30d: {
        requests: usage?._count._all ?? 0,
        tokens: usage?._sum.totalTokens ?? 0,
        cost: billed?._sum.cost ? Number(billed._sum.cost) : 0,
      },
    };
  }

  /** 名下成员（含近 30 天用量） */
  async members(agentId: string) {
    const since = new Date(Date.now() - 30 * DAY_MS);
    const members = await this.prisma.user.findMany({
      where: { agentId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        username: true,
        email: true,
        status: true,
        balance: true,
        priceMultiplier: true,
        createdAt: true,
      },
    });
    const ids = members.map((m) => m.id);
    const [usage, billed] = ids.length
      ? await Promise.all([
          this.prisma.requestLog.groupBy({
            by: ['userId'],
            where: { userId: { in: ids }, createdAt: { gte: since } },
            _count: { _all: true },
            _sum: { totalTokens: true },
          }),
          // 消费只计实际扣费（BYOK 调用不进余额）
          this.prisma.requestLog.groupBy({
            by: ['userId'],
            where: { userId: { in: ids }, createdAt: { gte: since }, chargeable: true },
            _sum: { cost: true },
          }),
        ])
      : [[], []];
    const map = new Map(usage.map((u) => [u.userId, u]));
    const billedMap = new Map(billed.map((u: any) => [u.userId, Number(u._sum.cost ?? 0)]));

    return members.map((m) => {
      const u = map.get(m.id);
      return {
        id: m.id,
        username: m.username,
        email: m.email,
        status: m.status,
        balance: Number(m.balance),
        priceMultiplier:
          m.priceMultiplier != null ? Number(m.priceMultiplier) : null,
        createdAt: m.createdAt,
        usage30d: {
          requests: u?._count._all ?? 0,
          tokens: u?._sum?.totalTokens ?? 0,
          cost: billedMap.get(m.id) ?? 0,
        },
      };
    });
  }

  /** 代理创建名下成员（role=USER，agentId=代理） */
  async createMember(agentId: string, dto: CreateMemberDto) {
    const email = dto.email.toLowerCase().trim();
    const [byEmail, byUsername] = await Promise.all([
      this.prisma.user.findUnique({ where: { email } }),
      this.prisma.user.findUnique({ where: { username: dto.username } }),
    ]);
    if (byEmail) throw new ConflictException('Email already registered');
    if (byUsername) throw new ConflictException('Username already taken');

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email,
        username: dto.username,
        passwordHash,
        role: 'USER',
        agentId,
      },
      select: {
        id: true,
        email: true,
        username: true,
        status: true,
        balance: true,
        priceMultiplier: true,
        createdAt: true,
      },
    });
    return { ...user, balance: Number(user.balance) };
  }

  /** 代理用自身余额给名下成员充值（转账，双方各记流水） */
  async rechargeMember(agentId: string, memberId: string, amountUsd: number) {
    const cost = round6(amountUsd);
    if (cost <= 0) throw new BadRequestException('Amount must be positive');

    const member = await this.prisma.user.findUnique({
      where: { id: memberId },
      select: { id: true, agentId: true, username: true },
    });
    if (!member || member.agentId !== agentId) {
      throw new NotFoundException('Member not found');
    }

    return this.prisma.$transaction(async (tx) => {
      const agent = await tx.user.findUnique({
        where: { id: agentId },
        select: { username: true },
      });
      if (!agent) throw new NotFoundException('Agent not found');
      // 条件扣减（与 withdrawal.service 同款）：命中 0 行 = 余额不足。
      // 先读后扣在并发充值下会把代理余额打成负数
      const dec = await tx.user.updateMany({
        where: { id: agentId, balance: { gte: cost } },
        data: { balance: { decrement: cost } },
      });
      if (dec.count === 0) throw new BadRequestException('代理余额不足');
      const au = await tx.user.findUniqueOrThrow({
        where: { id: agentId },
        select: { balance: true },
      });
      const mu = await tx.user.update({
        where: { id: memberId },
        data: { balance: { increment: cost } },
        select: { balance: true },
      });
      await tx.balanceTransaction.create({
        data: {
          userId: agentId,
          type: BalanceTxType.TRANSFER,
          amount: -cost,
          balanceAfter: round6(Number(au.balance)),
          description: `转给成员 ${member.username}`,
        },
      });
      await tx.balanceTransaction.create({
        data: {
          userId: memberId,
          type: BalanceTxType.TRANSFER,
          amount: cost,
          balanceAfter: round6(Number(mu.balance)),
          description: `来自代理 ${agent.username}`,
        },
      });
      return {
        agentBalance: round6(Number(au.balance)),
        memberBalance: round6(Number(mu.balance)),
      };
    });
  }
}
