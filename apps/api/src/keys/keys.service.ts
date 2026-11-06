import { Injectable, NotFoundException } from '@nestjs/common';
import { ApiKeyStatus, ChannelStatus, RoutingStrategy } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { GroupsService } from '../groups/groups.service';
import { UpstreamProbeService } from '../gateway/providers/upstream-probe.service';
import { CreateKeyDto } from './dto/create-key.dto';
import { UpdateKeyDto } from './dto/update-key.dto';

/** Key「测试连通性」结果：诊断性质，不含计费/调用记录 */
export interface KeyTestResult {
  ok: boolean;
  code?: string;
  message?: string;
  model?: string;
  upstreamModel?: string;
  channel?: { id: string; name: string; ownerType: string };
  /** 命中的候选渠道数（>1 表示还有备选） */
  candidates?: number;
  status?: number;
  latencyMs?: number;
  sample?: string;
  error?: string;
}

/** 渠道白名单归一：trim + 去空 + 去重（保持顺序）；null → []（不限制） */
function normalizeChannelIds(v?: string[] | null): string[] {
  if (!v) return [];
  return [...new Set(v.map((s) => s.trim()).filter(Boolean))];
}

@Injectable()
export class KeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly groups: GroupsService,
    private readonly probe: UpstreamProbeService,
  ) {}

  async list(userId: string) {
    const keys = await this.prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { group: { select: { id: true, name: true, displayName: true } } },
    });
    return keys.map((k) => this.publicView(k));
  }

  private publicView(k: {
    id: string;
    name: string;
    keyPrefix: string;
    status: ApiKeyStatus;
    quotaLimit: number | null;
    quotaUsed: number;
    costLimit: unknown;
    costUsed: unknown;
    rpmLimit: number | null;
    routingStrategy: RoutingStrategy | null;
    tpmLimit: number | null;
    models: string[];
    /** 渠道白名单；缺省视为不限制（旧数据/测试行可能没有该字段） */
    allowedChannelIds?: string[];
    groupId: string | null;
    group?: { id: string; name: string; displayName: string } | null;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: k.id,
      name: k.name,
      keyPrefix: `${k.keyPrefix}...`,
      status: k.status,
      quotaLimit: k.quotaLimit,
      quotaUsed: k.quotaUsed,
      costLimit: k.costLimit,
      costUsed: k.costUsed,
      rpmLimit: k.rpmLimit,
      routingStrategy: k.routingStrategy,
      tpmLimit: k.tpmLimit,
      models: k.models,
      allowedChannelIds: k.allowedChannelIds ?? [],
      groupId: k.groupId,
      group: k.group ?? null,
      expiresAt: k.expiresAt,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
    };
  }

  async create(userId: string, dto: CreateKeyDto, isAdmin = false) {
    const { plaintext, hash, prefix } = this.crypto.generateApiKey();
    const key = await this.prisma.apiKey.create({
      data: {
        userId,
        name: dto.name,
        keyHash: hash,
        keyPrefix: prefix,
        quotaLimit: dto.quotaLimit ?? null,
        costLimit: dto.costLimit ?? null,
        rpmLimit: dto.rpmLimit ?? null,
        routingStrategy: dto.routingStrategy ?? null,
        tpmLimit: dto.tpmLimit ?? null,
        models: dto.models ?? [],
        // 渠道白名单：只收窄路由候选集（可见性规则仍先生效），空 = 不限制
        allowedChannelIds: normalizeChannelIds(dto.allowedChannelIds),
        // 分组只允许管理员指定，普通用户创建的 Key 一律继承用户分组
        groupId: isAdmin ? (dto.groupId ?? null) : null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
    });
    // plaintext returned ONLY once
    return {
      ...this.publicView(key),
      plaintext,
      warning: 'Store this key now. It will not be shown again.',
    };
  }

  private async findOwned(userId: string, id: string) {
    const key = await this.prisma.apiKey.findFirst({ where: { id, userId } });
    if (!key)
      throw new NotFoundException({
        code: 'API_KEY_NOT_FOUND',
        message: 'API key not found',
      });
    return key;
  }

  async update(userId: string, id: string, dto: UpdateKeyDto, isAdmin = false) {
    await this.findOwned(userId, id);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.quotaLimit !== undefined) data.quotaLimit = dto.quotaLimit;
    if (dto.costLimit !== undefined) data.costLimit = dto.costLimit;
    if (dto.rpmLimit !== undefined) data.rpmLimit = dto.rpmLimit;
    if (dto.routingStrategy !== undefined) data.routingStrategy = dto.routingStrategy;
    if (dto.tpmLimit !== undefined) data.tpmLimit = dto.tpmLimit;
    if (dto.models !== undefined) data.models = dto.models ?? [];
    if (dto.allowedChannelIds !== undefined)
      data.allowedChannelIds = normalizeChannelIds(dto.allowedChannelIds);
    // 分组只允许管理员调整
    if (isAdmin && dto.groupId !== undefined) data.groupId = dto.groupId;
    if (dto.expiresAt !== undefined) {
      data.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    }
    const key = await this.prisma.apiKey.update({ where: { id }, data });
    return this.publicView(key);
  }

  async remove(userId: string, id: string) {
    await this.findOwned(userId, id);
    await this.prisma.$transaction(async (tx) => {
      // 删除 Key 会因其 UsageDaily.apiKeyId 为 SetNull 而置空；
      // 若同一 (user,date) 已存在 NULL 桶，会触发分部唯一索引冲突。这里先并入 NULL 桶再删除。
      const rows = await tx.usageDaily.findMany({ where: { apiKeyId: id } });
      for (const r of rows) {
        const existing = await tx.usageDaily.findFirst({
          where: { userId: r.userId, apiKeyId: null, date: r.date },
        });
        if (existing && existing.id !== r.id) {
          await tx.usageDaily.update({
            where: { id: existing.id },
            data: {
              requests: { increment: r.requests },
              promptTokens: { increment: r.promptTokens },
              completionTokens: { increment: r.completionTokens },
              totalTokens: { increment: r.totalTokens },
              cost: { increment: r.cost },
              billedCost: { increment: r.billedCost },
            },
          });
          await tx.usageDaily.delete({ where: { id: r.id } });
        } else {
          await tx.usageDaily.update({ where: { id: r.id }, data: { apiKeyId: null } });
        }
      }
      await tx.apiKey.delete({ where: { id } });
    });
    return { success: true };
  }

  private async findOwn(userId: string, id: string) {
    const key = await this.prisma.apiKey.findFirst({ where: { id, userId } });
    if (!key) {
      throw new NotFoundException({ code: 'API_KEY_NOT_FOUND', message: 'API key not found' });
    }
    return key;
  }

  /** Key 本身不可用（停用/过期/额度用尽）时的原因；可用返回 null */
  private keyUnusable(key: {
    status: ApiKeyStatus;
    expiresAt: Date | null;
    quotaLimit: number | null;
    quotaUsed: number;
    costLimit: unknown;
    costUsed: unknown;
  }): KeyTestResult | null {
    if (key.status !== ApiKeyStatus.ACTIVE) {
      return { ok: false, code: 'KEY_DISABLED', message: '该 Key 已停用或吊销，请先启用' };
    }
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
      return { ok: false, code: 'KEY_EXPIRED', message: '该 Key 已过期' };
    }
    if (key.quotaLimit != null && key.quotaUsed >= key.quotaLimit) {
      return { ok: false, code: 'KEY_QUOTA_EXCEEDED', message: '该 Key 的 Token 额度已用尽' };
    }
    if (key.costLimit != null && Number(key.costUsed) >= Number(key.costLimit)) {
      return { ok: false, code: 'KEY_COST_EXCEEDED', message: '该 Key 的费用额度已用尽' };
    }
    return null;
  }

  /** 该 Key 可用于测试的模型：白名单优先；否则取可见且启用渠道所支持、分组可见的模型 */
  async testModels(userId: string, keyId: string): Promise<string[]> {
    const key = await this.findOwn(userId, keyId);
    const configured = key.models.map((m) => m.trim()).filter(Boolean);
    if (configured.length) return [...new Set(configured)];

    const group = await this.groups.effectiveGroup({ id: key.userId }, key.groupId);
    const visibility = this.groups.channelScopeWhere(key.userId, group.id);
    const allowIds = key.allowedChannelIds ?? [];
    const rows = await this.prisma.channelModel.findMany({
      where: {
        enabled: true,
        channel: {
          AND: [
            { status: ChannelStatus.ENABLED },
            visibility,
            ...(allowIds.length > 0 ? [{ id: { in: allowIds } }] : []),
          ],
        },
      },
      select: { modelName: true },
      distinct: ['modelName'],
      orderBy: { modelName: 'asc' },
      take: 200,
    });
    const names = rows.map((r) => r.modelName).filter((n) => this.groups.isModelVisible(group, n));
    return [...new Set(names)];
  }

  /**
   * 测试连通性：按该 Key 的可见性与白名单选一条渠道，向上游发一次最小探针。
   *
   * 只做诊断：不写 RequestLog、不产生用量与费用、不改渠道健康度（与渠道页「测试」同口径）；
   * 失败按上游真实错误透出（Key 失效 / 余额耗尽 / 渠道全部停用等），便于自助定位。
   */
  async test(userId: string, keyId: string, model?: string): Promise<KeyTestResult> {
    const key = await this.findOwn(userId, keyId);
    const unusable = this.keyUnusable(key);
    if (unusable) return unusable;

    const target = (model?.trim() || (await this.testModels(userId, keyId))[0] || '').trim();
    if (!target) {
      return {
        ok: false,
        code: 'KEY_TEST_NO_MODEL',
        message: '当前 Key 没有可测试的模型，请先添加渠道或放宽模型白名单',
      };
    }

    const bare = target.replace(/:latest$/i, '');
    const catalogRow = await this.prisma.modelCatalog.findFirst({
      where: { OR: [{ name: bare }, { aliases: { has: bare } }] },
      select: { name: true, enabled: true },
    });
    const canonical = catalogRow?.name ?? bare;
    if (catalogRow && catalogRow.enabled === false) {
      return {
        ok: false,
        code: 'KEY_TEST_MODEL_DISABLED',
        message: `模型 ${canonical} 已在模型目录停用`,
      };
    }
    if (!this.whitelistAllows(key.models, target, canonical)) {
      return {
        ok: false,
        code: 'KEY_MODEL_NOT_ALLOWED',
        message: `模型 ${target} 不在该 Key 的白名单内`,
      };
    }

    const group = await this.groups.effectiveGroup({ id: key.userId }, key.groupId);
    const visibility = this.groups.channelScopeWhere(key.userId, group.id);
    const allowIds = key.allowedChannelIds ?? [];
    const keyAllow = allowIds.length > 0 ? [{ id: { in: allowIds } }] : [];
    const rows = await this.prisma.channelModel.findMany({
      where: {
        modelName: canonical,
        enabled: true,
        channel: { AND: [{ status: ChannelStatus.ENABLED }, visibility, ...keyAllow] },
      },
      include: { channel: true },
      orderBy: [
        { priority: { sort: 'desc', nulls: 'last' } },
        { weight: { sort: 'desc', nulls: 'last' } },
      ],
      take: 5,
    });
    if (!rows.length) {
      // 区分「渠道全停用」与「根本没有渠道支持该模型」：前者给出可执行的修复指引
      const configured = await this.prisma.channelModel.count({
        where: {
          modelName: canonical,
          enabled: true,
          channel: { AND: [visibility, ...keyAllow] },
        },
      });
      return configured > 0
        ? {
            ok: false,
            code: 'KEY_TEST_CHANNEL_DISABLED',
            message: `模型 ${canonical} 的渠道均已停用，请到「我的渠道」检查并启用`,
          }
        : {
            ok: false,
            code: 'KEY_TEST_NO_CHANNEL',
            message: `当前没有渠道支持模型 ${canonical}（或超出该 Key 的渠道白名单）`,
          };
    }

    const hit = rows[0];
    let apiKey: string;
    try {
      apiKey = this.crypto.decrypt(hit.channel.apiKeyEnc);
    } catch {
      return {
        ok: false,
        code: 'KEY_TEST_CHANNEL_KEY_UNREADABLE',
        message: '命中渠道的上游 Key 无法解密，请重新填写该渠道 Key',
      };
    }
    const probe = await this.probe.run({
      provider: hit.channel.provider,
      baseUrl: hit.channel.baseUrl,
      apiKey,
      model: hit.upstreamModelName ?? canonical,
    });
    return {
      ok: probe.ok,
      model: target,
      upstreamModel: hit.upstreamModelName ?? canonical,
      channel: { id: hit.channel.id, name: hit.channel.name, ownerType: hit.channel.ownerType },
      candidates: rows.length,
      status: probe.status,
      latencyMs: probe.latencyMs,
      ...(probe.ok ? { sample: probe.sample } : { error: probe.error }),
    };
  }

  /** 模型白名单匹配（兼容目录别名与 `:latest` 后缀） */
  private whitelistAllows(whitelist: string[], requested: string, canonical: string): boolean {
    const list = whitelist.map((m) => m.trim()).filter(Boolean);
    if (!list.length) return true;
    const norm = (m: string) => m.replace(/:latest$/i, '');
    const wanted = new Set([norm(requested), norm(canonical)]);
    return list.some((m) => wanted.has(norm(m)));
  }
}
