import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Channel,
  ChannelModel,
  ChannelOwnerType,
  ChannelShareMode,
  ChannelShareUrgency,
  ChannelStatus,
  ModelGroupStatus,
  Prisma,
  Role,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { AuthUser } from '../common/interfaces/auth.interface';
import { ProviderRegistry } from '../gateway/providers/provider.registry';
import { Provider, UpstreamError } from '../gateway/types';
import {
  assertPublicHttpUrl,
  safeFetch,
  UnsafeUrlError,
  upstreamAllowsPrivate,
} from '../common/url-safety';
import { joinUrl } from '../gateway/providers/stream.util';
import { redactSecrets } from '../common/redact.util';
import { GroupsService } from '../groups/groups.service';
import { shareExhausted } from '../gateway/channel-share.util';
import { CreateChannelDto } from './dto/create-channel.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { ChannelModelPriceDto } from './dto/channel-model-price.dto';

export interface ChannelQuery {
  page?: number;
  pageSize?: number;
  name?: string;
  provider?: string;
  status?: ChannelStatus;
  ownerType?: ChannelOwnerType;
  model?: string;
  userId?: string;
}

function rawUpstreamError(body: any, fallback: string): string {
  if (body == null) return fallback;
  if (typeof body === 'string') return body.slice(0, 1000) || fallback;
  const err = body.error;
  if (typeof err === 'string') return err;
  if (err?.message) return String(err.message);
  if (body.message) return String(body.message);
  if (body.msg) return String(body.msg);
  if (body.detail) {
    return typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
  }
  try {
    return JSON.stringify(body).slice(0, 1000);
  } catch {
    return fallback;
  }
}

function safeStringify(value: any): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 2000);
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    return null;
  }
}

/** 控制台出口统一脱敏：上游报错可能回显完整密钥（实测 TokenFleet MiniMax-M2.5 回 sk-e280…） */
function extractUpstreamError(body: any, fallback: string): string {
  return redactSecrets(rawUpstreamError(body, fallback));
}

function redactDetail(value: string | null): string | null {
  return value == null ? null : redactSecrets(value);
}

/** 解析上游模型列表响应：兼容 OpenAI 风格 data[].id 与 Gemini 风格 models[].name */
function extractModelIds(json: any): string[] {
  const raw: string[] = [];
  if (Array.isArray(json?.data)) {
    for (const it of json.data) {
      if (typeof it === 'string') raw.push(it);
      else if (typeof it?.id === 'string') raw.push(it.id);
      else if (typeof it?.name === 'string') raw.push(it.name);
    }
  }
  if (Array.isArray(json?.models)) {
    for (const it of json.models) {
      const name = typeof it === 'string' ? it : it?.name;
      if (typeof name === 'string') raw.push(name);
    }
  }
  const ids = raw
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('tunedModels/'))
    .map((s) => s.replace(/^models\//, ''));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 1000);
}

/** 归一化时间戳：DTO 传 ISO 字符串、库行是 Date；不可解析 → null。 */
function shareTime(v: string | Date): number | null {
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly providers: ProviderRegistry,
    private readonly groups: GroupsService,
  ) {}

  private async assertSafeBaseUrl(baseUrl: string): Promise<void> {
    // 生产环境禁止渠道 baseUrl 指向私网/回环（SSRF）；如需本地 mock 上游可设 ALLOW_PRIVATE_UPSTREAM=true
    if (upstreamAllowsPrivate()) return;
    try {
      await assertPublicHttpUrl(baseUrl);
    } catch (e) {
      throw new BadRequestException(
        e instanceof UnsafeUrlError
          ? { code: e.code, message: e.message, details: e.details }
          : { code: 'CHANNEL_BASE_URL_UNSAFE', message: 'baseUrl 不安全' },
      );
    }
  }

  private view(
    c: Channel & {
      modelPrices?: ChannelModel[];
      groups?: { id: string; name: string; displayName: string }[];
    },
  ) {
    let preview: string;
    try {
      const key = this.crypto.decrypt(c.apiKeyEnc);
      preview = key.length > 4 ? `****${key.slice(-4)}` : '****';
    } catch {
      preview = '****';
    }
    const { apiKeyEnc, modelPrices, groups, shareRevenue, ...rest } = c;
    return {
      ...rest,
      /**
       * 累计共享分成收益（渠道主实收，USD 十进制字符串）。
       * 由 Channel.shareRevenue 在热路径闭环累加（见 UsageService.record），
       * 读取 O(1)——若改为逐 RequestLog 聚合，会随渠道请求量线性退化。
       */
      revenue: String(shareRevenue ?? 0),
      apiKeyPreview: preview,
      hasApiKey: !!apiKeyEnc,
      groups: (groups ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        displayName: g.displayName,
      })),
      modelPrices: (modelPrices ?? []).map((m) => ({
        model: m.modelName,
        upstreamModelName: m.upstreamModelName ?? null,
        costInput: m.costInput != null ? Number(m.costInput) : null,
        costOutput: m.costOutput != null ? Number(m.costOutput) : null,
        priceInput: m.priceInput != null ? Number(m.priceInput) : null,
        priceOutput: m.priceOutput != null ? Number(m.priceOutput) : null,
        costPerCall: m.costPerCall != null ? Number(m.costPerCall) : null,
        pricePerCall: m.pricePerCall != null ? Number(m.pricePerCall) : null,
        discount: m.discount != null ? Number(m.discount) : null,
        costDiscount: m.costDiscount != null ? Number(m.costDiscount) : null,
        priceDiscount: m.priceDiscount != null ? Number(m.priceDiscount) : null,
        enabled: m.enabled,
        priority: m.priority,
        weight: m.weight,
        qualityScore: m.qualityScore != null ? Number(m.qualityScore) : 1,
      })),
    };
  }

  /**
   * 同步渠道×模型定价行；prune=true 时删除不在列表中的模型行。
   * 传入 tx（交互事务客户端）时复用调用方事务——渠道行与模型行整体原子；
   * 未传时保持原有的独立批量事务（批量 + prune 放进同一事务）。
   */
  private async upsertChannelModels(
    channelId: string,
    models: string[],
    modelPrices?: ChannelModelPriceDto[],
    prune = false,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    const priceMap = new Map((modelPrices ?? []).map((p) => [p.model, p]));
    const names = new Set<string>([...models, ...priceMap.keys()]);
    // 只覆盖客户端显式给出的字段：未传的字段（qualityScore / 绝对成本 / weight / enabled 等）
    // 保持原值，避免「只改折扣」的保存把其它配置重置为默认
    const OPTIONAL_FIELDS = [
      'upstreamModelName',
      'costInput',
      'costOutput',
      'priceInput',
      'priceOutput',
      'costPerCall',
      'pricePerCall',
      'discount',
      'costDiscount',
      'priceDiscount',
      'priority',
      'weight',
      'qualityScore',
    ] as const;
    // 批量 + prune 放进同一事务：中途失败不会留下「半份模型表」
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const model of names) {
      const p = priceMap.get(model);
      const pricing: Record<string, unknown> = {};
      if (p) {
        for (const k of OPTIONAL_FIELDS) {
          if (p[k] !== undefined) pricing[k] = p[k];
        }
        if (p.enabled !== undefined) pricing.enabled = p.enabled;
      }
      ops.push(
        client.channelModel.upsert({
          where: { channelId_modelName: { channelId, modelName: model } },
          create: { channelId, modelName: model, enabled: true, ...pricing },
          update: pricing,
        }),
      );
    }
    if (prune) {
      ops.push(
        client.channelModel.deleteMany({
          where: { channelId, modelName: { notIn: [...names] } },
        }),
      );
    }
    if (!ops.length) return;
    if (tx) {
      // 已在调用方的交互事务内：逐条 await 复用同一事务连接，
      // 任一条失败都由外层事务整体回滚（事务客户端不支持嵌套 $transaction）
      for (const op of ops) await op;
    } else {
      await this.prisma.$transaction(ops);
    }
  }

  async list(user: AuthUser, q: ChannelQuery = {}) {
    const page = q.page && q.page > 0 ? q.page : 1;
    const pageSize = q.pageSize && q.pageSize > 0 ? Math.min(q.pageSize, 100) : 20;

    const where: Prisma.ChannelWhereInput = {};
    if (user.role === Role.ADMIN) {
      if (q.ownerType) where.ownerType = q.ownerType;
      if (q.userId) where.ownerUserId = q.userId;
    } else {
      where.ownerType = ChannelOwnerType.USER;
      where.ownerUserId = user.id;
    }
    if (q.name) where.name = { contains: q.name, mode: 'insensitive' };
    if (q.provider) where.provider = q.provider;
    if (q.status) where.status = q.status;
    if (q.model) where.modelPrices = { some: { modelName: q.model, enabled: true } };

    const [items, total] = await Promise.all([
      this.prisma.channel.findMany({
        where,
        include: {
          modelPrices: true,
          groups: { select: { id: true, name: true, displayName: true } },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.channel.count({ where }),
    ]);
    return { items: items.map((c) => this.view(c)), total, page, pageSize };
  }

  /** 当前用户可调用的模型，按渠道分组（自有 BYOK + 平台，按生效分组过滤），用于控制台展示。 */
  async availableModels(user: AuthUser) {
    const group = await this.groups.effectiveGroup({ id: user.id });
    // 与网关 resolve() 同口径（含共享渠道）：自有 BYOK / 他人公开共享 / 他人同分组共享 / 平台按分组
    const visibility = this.groups.channelScopeWhere(user.id, group.id);
    const rows = await this.prisma.channelModel.findMany({
      where: {
        enabled: true,
        channel: {
          status: ChannelStatus.ENABLED,
          AND: [visibility],
        },
      },
      select: {
        modelName: true,
        channel: {
          select: {
            id: true,
            name: true,
            ownerType: true,
            ownerUserId: true,
            provider: true,
            shareMode: true,
            shareUntil: true,
            shareQuotaCostUsd: true,
            shareQuotaRequests: true,
            shareUsedCostUsd: true,
            shareUsedRequests: true,
          },
        },
      },
      orderBy: { modelName: 'asc' },
    });
    const flat = new Set<string>();
    const byChannel = new Map<string, (typeof rows)[number]['channel'] & { models: string[] }>();
    for (const r of rows) {
      // 共享渠道已达额度/到期 → 不再对外展示（与网关路由同口径）；属主豁免（自己的渠道不吃共享额度）
      if (shareExhausted(r.channel, undefined, user.id)) continue;
      // 模型分组可见性：分组未配置可见模型 = 不限制
      if (!this.groups.isModelVisible(group, r.modelName)) continue;
      flat.add(r.modelName);
      const ch = byChannel.get(r.channel.id) ?? { ...r.channel, models: [] };
      ch.models.push(r.modelName);
      byChannel.set(r.channel.id, ch);
    }
    return { channels: [...byChannel.values()], models: [...flat].sort() };
  }

  async create(user: AuthUser, dto: CreateChannelDto) {
    const wantPlatform = dto.ownerType === ChannelOwnerType.PLATFORM;
    if (wantPlatform && user.role !== Role.ADMIN) {
      throw new ForbiddenException({
        code: 'CHANNEL_PLATFORM_ADMIN_ONLY',
        message: 'Only admins can create platform channels',
      });
    }
    const ownerType = wantPlatform ? ChannelOwnerType.PLATFORM : ChannelOwnerType.USER;

    await this.assertSafeBaseUrl(dto.baseUrl);
    // 分组存在性/启用校验必须在事务启动之前（失败则不写任何行）
    await this.assertGroupsUsable(dto.groups);

    // 渠道行 + 模型行 + 终读同一交互事务，失败不残留半份配置
    return this.prisma.$transaction(async (tx) => {
      const channel = await tx.channel.create({
        data: {
          ownerType,
          ownerUserId: ownerType === ChannelOwnerType.USER ? user.id : null,
          name: dto.name,
          provider: dto.provider,
          baseUrl: dto.baseUrl,
          apiKeyEnc: this.crypto.encrypt(dto.apiKey),
          models: dto.models,
          groups: dto.groups?.length
            ? { connect: dto.groups.map((id) => ({ id })) }
            : undefined,
          upstreamGroup: dto.upstreamGroup ?? null,
          // 共享设置：仅自有渠道有意义；抽成只有管理员能设
          shareMode: dto.shareMode ?? ChannelShareMode.PRIVATE,
          shareUrgency: dto.shareUrgency ?? ChannelShareUrgency.NORMAL,
          shareQuotaCostUsd: dto.shareQuotaCostUsd ?? null,
          shareQuotaRequests: dto.shareQuotaRequests ?? null,
          shareUntil: dto.shareUntil ? new Date(dto.shareUntil) : null,
          shareFeeBps: user.role === Role.ADMIN ? (dto.shareFeeBps ?? null) : null,
          weight: dto.weight ?? 1,
          priority: dto.priority ?? 0,
          dailyRequestLimit: dto.dailyRequestLimit ?? null,
          dailyTokenLimit: dto.dailyTokenLimit ?? null,
        },
      });
      await this.upsertChannelModels(channel.id, dto.models, dto.modelPrices, true, tx);
      const fresh = await tx.channel.findUnique({
        where: { id: channel.id },
        include: { modelPrices: true },
      });
      return this.view(fresh!);
    });
  }

  private async findAccessible(user: AuthUser, id: string): Promise<Channel> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel)
      throw new NotFoundException({
        code: 'CHANNEL_NOT_FOUND',
        message: 'Channel not found',
      });
    const isAdmin = user.role === Role.ADMIN;
    const isOwner = channel.ownerType === ChannelOwnerType.USER && channel.ownerUserId === user.id;
    if (!isAdmin && !isOwner) {
      throw new NotFoundException({
        code: 'CHANNEL_NOT_FOUND',
        message: 'Channel not found',
      });
    }
    return channel;
  }

  /**
   * 批量校验分组 id 全部存在且为 ENABLED；任一不存在或已停用则整体拒绝。
   * 必须在 $transaction 之前调用（校验失败绝不启动事务/不落任何行）。
   */
  private async assertGroupsUsable(groups: string[] | undefined): Promise<void> {
    if (!groups?.length) return;
    const unique = [...new Set(groups)];
    const rows = await this.prisma.modelGroup.findMany({
      where: { id: { in: unique } },
      select: { id: true, status: true },
    });
    const usable = new Set(
      rows.filter((r) => r.status === ModelGroupStatus.ENABLED).map((r) => r.id),
    );
    const invalid = unique.filter((id) => !usable.has(id));
    if (invalid.length) {
      throw new BadRequestException({
        code: 'CHANNEL_GROUP_INVALID',
        message: `分组不存在或已停用: ${invalid.join(', ')}`,
        details: { ids: invalid.join(', ') },
      });
    }
  }

  async update(user: AuthUser, id: string, dto: UpdateChannelDto) {
    const existing = await this.findAccessible(user, id);
    if (dto.baseUrl) await this.assertSafeBaseUrl(dto.baseUrl);
    await this.assertGroupsUsable(dto.groups);
    // 共享已用量清零：显式要求，或 shareUntil 被延长（新时间严格晚于旧值）
    const nextShare = shareTime(dto.shareUntil ?? '');
    const prevShare = shareTime(existing.shareUntil ?? '');
    const resetShareUsed =
      dto.resetShareUsed === true ||
      (nextShare != null && prevShare != null && nextShare > prevShare);
    // 渠道行更新 + 模型行 upsert/prune + 终读同一交互事务，任一步失败整体回滚
    return this.prisma.$transaction(async (tx) => {
      const channel = await tx.channel.update({
        where: { id },
        data: {
          name: dto.name,
          provider: dto.provider,
          baseUrl: dto.baseUrl,
          models: dto.models,
          groups:
            dto.groups !== undefined ? { set: dto.groups.map((id) => ({ id })) } : undefined,
          upstreamGroup: dto.upstreamGroup,
          // 共享设置（自有渠道有意义）
          shareMode: dto.shareMode,
          shareUrgency: dto.shareUrgency,
          shareQuotaCostUsd: dto.shareQuotaCostUsd,
          shareQuotaRequests: dto.shareQuotaRequests,
          shareUntil:
            dto.shareUntil === undefined
              ? undefined
              : dto.shareUntil
                ? new Date(dto.shareUntil)
                : null,
          // 清零只作用于已用用量，累计分成 shareRevenue 永不动；两条件同时命中也只清一次
          ...(resetShareUsed ? { shareUsedRequests: 0, shareUsedCostUsd: 0 } : {}),
          // 抽成仅管理员可改
          shareFeeBps: user.role === Role.ADMIN ? dto.shareFeeBps : undefined,
          weight: dto.weight,
          priority: dto.priority,
          status: dto.status,
          // undefined = 不修改；null = 清除限额
          dailyRequestLimit: dto.dailyRequestLimit,
          dailyTokenLimit: dto.dailyTokenLimit,
          ...(dto.apiKey ? { apiKeyEnc: this.crypto.encrypt(dto.apiKey) } : {}),
          ...(dto.status === ChannelStatus.ENABLED
            ? { failureCount: 0, autoDisabled: false, lastErrorMsg: null }
            : {}),
        },
      });
      if (dto.models !== undefined || dto.modelPrices !== undefined) {
        await this.upsertChannelModels(
          id,
          dto.models ?? channel.models,
          dto.modelPrices,
          dto.models !== undefined,
          tx,
        );
      }
      const fresh = await tx.channel.findUnique({
        where: { id },
        include: { modelPrices: true },
      });
      return this.view(fresh!);
    });
  }

  async remove(user: AuthUser, id: string) {
    await this.findAccessible(user, id);
    await this.prisma.channel.delete({ where: { id } });
    return { success: true };
  }

  /** 真实连通性测试：向指定上游发一次最小请求，返回延迟与结果。 */
  private async runUpstreamTest(input: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  }) {
    const provider = this.providers.resolve(input.provider);
    // 视频能力模型不支持 /chat/completions（上游回 endpoint not available），聊天探针必然
    // 误判为失败 —— 改走只读的任务状态探测（随机假任务 ID，不产生任何生成）
    if (
      (await this.modelCapabilities(input.model)).includes('video') &&
      typeof provider.videoStatus === 'function'
    ) {
      return this.runVideoProbe(provider, input);
    }
    const started = Date.now();
    try {
      const result = await provider.chatNonStream(
        { baseUrl: input.baseUrl } as Channel,
        input.apiKey,
        {
          model: input.model,
          // 最小化请求体，最大化兼容性（max_tokens 等由各协议适配器按需补默认值）
          body: {
            model: input.model,
            messages: [{ role: 'user', content: 'ping' }],
          },
          timeoutMs: 20000,
        },
      );
      const latencyMs = Date.now() - started;
      const sample = result.json?.choices?.[0]?.message?.content;
      return {
        ok: true,
        status: result.status,
        latencyMs,
        model: input.model,
        provider: input.provider,
        sample: typeof sample === 'string' ? sample.slice(0, 200) : '',
      };
    } catch (e) {
      const latencyMs = Date.now() - started;
      const base = {
        ok: false,
        latencyMs,
        model: input.model,
        provider: input.provider,
      };
      if (e instanceof UpstreamError) {
        return {
          ...base,
          status: e.status,
          error: extractUpstreamError(e.body, e.message),
          detail: redactDetail(safeStringify(e.body)),
        };
      }
      return {
        ...base,
        status: 0,
        error: redactSecrets((e as Error)?.message ?? 'unknown error'),
        detail: null,
      };
    }
  }

  /** 模型能力（目录行）；目录缺失/查询失败一律降级 [] → 保持原聊天探针行为 */
  private async modelCapabilities(model: string): Promise<string[]> {
    try {
      const row = await this.prisma.modelCatalog.findFirst({
        where: { OR: [{ name: model }, { aliases: { has: model } }] },
        select: { capabilities: true },
      });
      return row?.capabilities ?? [];
    } catch {
      return [];
    }
  }

  /**
   * 视频模型连通性探测：GET /videos/{随机假任务ID}（只读，不触发生成）。
   * - 4xx 且错误体带 task 语义（任务不存在）→ 端点与鉴权可达 = 通过
   * - 连接失败 / 5xx / 鉴权失败 / 端点缺失（无 task 语义）→ 失败并透出上游错误
   */
  private async runVideoProbe(
    provider: Provider,
    input: { provider: string; baseUrl: string; apiKey: string; model: string },
  ) {
    const started = Date.now();
    try {
      const result = await provider.videoStatus!(
        { baseUrl: input.baseUrl } as Channel,
        input.apiKey,
        { taskId: `conn_probe_${Date.now()}`, timeoutMs: 20000 },
      );
      return {
        ok: true,
        status: result.status,
        latencyMs: Date.now() - started,
        model: input.model,
        provider: input.provider,
        sample: 'video route reachable',
      };
    } catch (e) {
      const latencyMs = Date.now() - started;
      const base = { model: input.model, provider: input.provider };
      if (e instanceof UpstreamError) {
        const text = `${e.message} ${safeStringify(e.body) ?? ''}`;
        const taskScope =
          (e.status === 400 || e.status === 404 || e.status === 410 || e.status === 422) &&
          /task/i.test(text);
        if (taskScope) {
          return {
            ok: true,
            status: e.status,
            latencyMs,
            ...base,
            sample: 'video route reachable (unknown task)',
          };
        }
        return {
          ...base,
          ok: false,
          status: e.status,
          latencyMs,
          error: extractUpstreamError(e.body, e.message),
          detail: redactDetail(safeStringify(e.body)),
        };
      }
      return {
        ...base,
        ok: false,
        status: 0,
        latencyMs,
        error: redactSecrets((e as Error)?.message ?? 'unknown error'),
        detail: null,
      };
    }
  }

  /** 批量测试（限并发，避免打爆上游）。 */
  private async runUpstreamTests(
    input: { provider: string; baseUrl: string; apiKey: string },
    models: string[],
    concurrency = 3,
  ) {
    const results: Awaited<ReturnType<ChannelsService['runUpstreamTest']>>[] = new Array(
      models.length,
    );
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= models.length) break;
        results[i] = await this.runUpstreamTest({ ...input, model: models[i] });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, models.length) }, () => worker()));
    const ok = results.filter((r) => r.ok).length;
    return {
      results,
      summary: { total: models.length, ok, failed: models.length - ok },
    };
  }

  /** 测试已保存渠道；不指定模型时测试该渠道全部模型。 */
  async testChannel(user: AuthUser, id: string, opts: { model?: string; models?: string[] } = {}) {
    const channel = await this.findAccessible(user, id);
    let apiKey: string;
    try {
      apiKey = this.crypto.decrypt(channel.apiKeyEnc);
    } catch {
      throw new BadRequestException({
        code: 'CHANNEL_KEY_UNREADABLE',
        message: '渠道密钥无法解密，请重新填写上游 Key',
      });
    }
    const models = this.resolveTestModels(opts, channel.models);
    return this.runUpstreamTests(
      { provider: channel.provider, baseUrl: channel.baseUrl, apiKey },
      models,
    );
  }

  /** 测试未保存的渠道配置（新增/编辑弹窗内直接测）。apiKey 缺省时复用已存渠道密钥。 */
  async testConnection(
    user: AuthUser,
    dto: {
      provider: string;
      baseUrl: string;
      model?: string;
      models?: string[];
      apiKey?: string;
      channelId?: string;
    },
  ) {
    let apiKey = dto.apiKey?.trim();
    if (!apiKey) {
      if (!dto.channelId) {
        throw new BadRequestException({
          code: 'CHANNEL_UPSTREAM_KEY_REQUIRED',
          message: '请提供上游 API Key',
        });
      }
      const channel = await this.findAccessible(user, dto.channelId);
      try {
        apiKey = this.crypto.decrypt(channel.apiKeyEnc);
      } catch {
        throw new BadRequestException({
          code: 'CHANNEL_STORED_KEY_UNREADABLE',
          message: '已存密钥无法解密，请重新填写',
        });
      }
    }
    const models = this.resolveTestModels(dto, []);
    if (dto.baseUrl) await this.assertSafeBaseUrl(dto.baseUrl);
    return this.runUpstreamTests({ provider: dto.provider, baseUrl: dto.baseUrl, apiKey }, models);
  }

  /**
   * 拉取上游可用模型列表（OpenAI/Anthropic/Gemini 协议的模型列表接口），
   * 供渠道表单「获取上游模型」一键填充。baseUrl/apiKey 缺省时复用已保存渠道配置。
   */
  async fetchUpstreamModels(
    user: AuthUser,
    dto: { provider: string; baseUrl?: string; apiKey?: string; channelId?: string },
  ): Promise<{ models: string[]; total: number }> {
    let baseUrl = dto.baseUrl?.trim() ?? '';
    let apiKey = dto.apiKey?.trim() ?? '';
    if (dto.channelId && (!baseUrl || !apiKey)) {
      const channel = await this.findAccessible(user, dto.channelId);
      if (!baseUrl) baseUrl = channel.baseUrl;
      if (!apiKey) {
        try {
          apiKey = this.crypto.decrypt(channel.apiKeyEnc);
        } catch {
          throw new BadRequestException({
            code: 'CHANNEL_STORED_KEY_UNREADABLE',
            message: '已存密钥无法解密，请重新填写',
          });
        }
      }
    }
    if (!baseUrl)
      throw new BadRequestException({
        code: 'CHANNEL_BASE_URL_REQUIRED',
        message: '请填写 Base URL',
      });
    if (!apiKey)
      throw new BadRequestException({
        code: 'CHANNEL_UPSTREAM_KEY_REQUIRED',
        message: '请提供上游 API Key',
      });
    await this.assertSafeBaseUrl(baseUrl);
    const models = await this.listUpstreamModels(dto.provider, baseUrl, apiKey);
    return { models, total: models.length };
  }

  /** 请求上游模型列表：优先 {base}/models，404 且 Base URL 未带版本前缀时回退补 /v1（Gemini 补 /v1beta）。 */
  private async listUpstreamModels(
    provider: string,
    baseUrl: string,
    apiKey: string,
  ): Promise<string[]> {
    const base = baseUrl.replace(/\/+$/, '');
    const urls = /\/v\d+(beta)?$/i.test(base)
      ? [joinUrl(base, 'models')]
      : [
          joinUrl(base, 'models'),
          joinUrl(base, provider === 'gemini' ? 'v1beta/models' : 'v1/models'),
        ];
    const headers = this.modelsListHeaders(provider, apiKey);
    let res: Awaited<ReturnType<typeof fetch>> | undefined;
    for (const url of urls) {
      const target =
        provider === 'gemini' ? `${url}?pageSize=1000&key=${encodeURIComponent(apiKey)}` : url;
      try {
        // 用户可控的上游地址：逐跳校验 + 不自动跟随重定向（防止 302 转内网绕过 SSRF 校验）
        res = await safeFetch(target, { headers, signal: AbortSignal.timeout(15000) });
      } catch (e) {
        throw new BadRequestException(
          e instanceof UnsafeUrlError
            ? { code: e.code, message: e.message, details: e.details }
            : {
                code: 'CHANNEL_UPSTREAM_UNREACHABLE',
                message: `无法连接上游: ${e instanceof Error ? e.message : String(e)}`,
                details: { reason: e instanceof Error ? e.message : String(e) },
              },
        );
      }
      if (res.status !== 404 || url === urls[urls.length - 1]) break;
    }
    if (!res)
      throw new BadRequestException({
        code: 'CHANNEL_MODEL_LIST_FETCH_FAILED',
        message: '模型列表请求失败',
      });
    if (res.status === 404) {
      throw new BadRequestException({
        code: 'CHANNEL_MODEL_LIST_NOT_FOUND',
        message: '上游没有模型列表接口（404），请检查 Base URL',
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* 非 JSON 响应，用原文提示 */
      }
      const upstreamDetail = extractUpstreamError(body, text.slice(0, 300) || res.statusText);
      throw new BadRequestException({
        code: 'CHANNEL_UPSTREAM_ERROR',
        message: `上游返回 ${res.status}: ${upstreamDetail}`,
        details: { status: String(res.status), detail: upstreamDetail },
      });
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new BadRequestException({
        code: 'CHANNEL_MODEL_LIST_INVALID_JSON',
        message: '上游模型列表不是有效 JSON',
      });
    }
    const models = extractModelIds(json);
    if (!models.length) {
      throw new BadRequestException({
        code: 'CHANNEL_MODEL_LIST_EMPTY',
        message: '上游未返回任何模型，请检查 Key 与 Base URL',
      });
    }
    return models;
  }

  private modelsListHeaders(provider: string, apiKey: string): Record<string, string> {
    if (provider === 'anthropic') {
      return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    }
    if (provider === 'gemini') return {}; // key 走 URL 查询参数
    return { Authorization: `Bearer ${apiKey}` };
  }

  private resolveTestModels(
    opts: { model?: string; models?: string[] },
    fallback: string[],
  ): string[] {
    const list = (opts.models?.length ? opts.models : opts.model ? [opts.model] : fallback)
      .map((m) => m.trim())
      .filter(Boolean);
    const unique = [...new Set(list)];
    if (unique.length === 0) {
      throw new BadRequestException({
        code: 'CHANNEL_TEST_MODEL_REQUIRED',
        message: '请提供用于测试的模型名',
      });
    }
    // 单次测试上限（可用 TEST_MAX_MODELS 调整）
    const max = Number(process.env.TEST_MAX_MODELS ?? 100) || 100;
    return unique.slice(0, max);
  }
}
