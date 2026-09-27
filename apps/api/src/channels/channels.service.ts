import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Channel, ChannelModel, ChannelOwnerType, ChannelStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { AuthUser } from '../common/interfaces/auth.interface';
import { ProviderRegistry } from '../gateway/providers/provider.registry';
import { UpstreamError } from '../gateway/types';
import { assertPublicHttpUrl, UnsafeUrlError } from '../common/url-safety';
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

function extractUpstreamError(body: any, fallback: string): string {
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

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly providers: ProviderRegistry,
  ) {}

  private async assertSafeBaseUrl(baseUrl: string): Promise<void> {
    // 生产环境禁止渠道 baseUrl 指向私网/回环（SSRF）；如需本地 mock 上游可设 ALLOW_PRIVATE_UPSTREAM=true
    if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_PRIVATE_UPSTREAM === 'true') {
      return;
    }
    try {
      await assertPublicHttpUrl(baseUrl);
    } catch (e) {
      throw new BadRequestException(e instanceof UnsafeUrlError ? e.message : 'baseUrl 不安全');
    }
  }

  private view(c: Channel & { modelPrices?: ChannelModel[] }) {
    let preview = '';
    try {
      const key = this.crypto.decrypt(c.apiKeyEnc);
      preview = key.length > 4 ? `****${key.slice(-4)}` : '****';
    } catch {
      preview = '****';
    }
    const { apiKeyEnc, modelPrices, ...rest } = c;
    return {
      ...rest,
      apiKeyPreview: preview,
      hasApiKey: !!apiKeyEnc,
      modelPrices: (modelPrices ?? []).map((m) => ({
        model: m.modelName,
        costInput: m.costInput != null ? Number(m.costInput) : null,
        costOutput: m.costOutput != null ? Number(m.costOutput) : null,
        priceInput: m.priceInput != null ? Number(m.priceInput) : null,
        priceOutput: m.priceOutput != null ? Number(m.priceOutput) : null,
        discount: m.discount != null ? Number(m.discount) : null,
        enabled: m.enabled,
        priority: m.priority,
        weight: m.weight,
      })),
    };
  }

  /** 同步渠道×模型定价行；prune=true 时删除不在列表中的模型行 */
  private async upsertChannelModels(
    channelId: string,
    models: string[],
    modelPrices?: ChannelModelPriceDto[],
    prune = false,
  ): Promise<void> {
    const priceMap = new Map((modelPrices ?? []).map((p) => [p.model, p]));
    const names = new Set<string>([...models, ...priceMap.keys()]);
    for (const model of names) {
      const p = priceMap.get(model);
      const pricing = {
        costInput: p?.costInput ?? null,
        costOutput: p?.costOutput ?? null,
        priceInput: p?.priceInput ?? null,
        priceOutput: p?.priceOutput ?? null,
        discount: p?.discount ?? null,
        priority: p?.priority ?? null,
        weight: p?.weight ?? null,
        enabled: p?.enabled ?? true,
      };
      await this.prisma.channelModel.upsert({
        where: { channelId_modelName: { channelId, modelName: model } },
        create: { channelId, modelName: model, ...pricing },
        update: pricing,
      });
    }
    if (prune) {
      await this.prisma.channelModel.deleteMany({
        where: { channelId, modelName: { notIn: [...names] } },
      });
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
        include: { modelPrices: true },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.channel.count({ where }),
    ]);
    return { items: items.map((c) => this.view(c)), total, page, pageSize };
  }

  /** 当前用户可调用的模型，按渠道分组（自有 BYOK + 平台），用于控制台展示。 */
  async availableModels(user: AuthUser) {
    const rows = await this.prisma.channelModel.findMany({
      where: {
        enabled: true,
        channel: {
          status: ChannelStatus.ENABLED,
          OR: [
            { ownerType: ChannelOwnerType.USER, ownerUserId: user.id },
            { ownerType: ChannelOwnerType.PLATFORM },
          ],
        },
      },
      select: {
        modelName: true,
        channel: { select: { id: true, name: true, ownerType: true, provider: true } },
      },
      orderBy: { modelName: 'asc' },
    });
    const flat = new Set<string>();
    const byChannel = new Map<
      string,
      { id: string; name: string; ownerType: string; provider: string; models: string[] }
    >();
    for (const r of rows) {
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
      throw new ForbiddenException('Only admins can create platform channels');
    }
    const ownerType = wantPlatform
      ? ChannelOwnerType.PLATFORM
      : ChannelOwnerType.USER;

    await this.assertSafeBaseUrl(dto.baseUrl);

    const channel = await this.prisma.channel.create({
      data: {
        ownerType,
        ownerUserId: ownerType === ChannelOwnerType.USER ? user.id : null,
        name: dto.name,
        provider: dto.provider,
        baseUrl: dto.baseUrl,
        apiKeyEnc: this.crypto.encrypt(dto.apiKey),
        models: dto.models,
        weight: dto.weight ?? 1,
        priority: dto.priority ?? 0,
      },
    });
    await this.upsertChannelModels(channel.id, dto.models, dto.modelPrices, true);
    const fresh = await this.prisma.channel.findUnique({
      where: { id: channel.id },
      include: { modelPrices: true },
    });
    return this.view(fresh!);
  }

  private async findAccessible(user: AuthUser, id: string): Promise<Channel> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException('Channel not found');
    const isAdmin = user.role === Role.ADMIN;
    const isOwner =
      channel.ownerType === ChannelOwnerType.USER &&
      channel.ownerUserId === user.id;
    if (!isAdmin && !isOwner) {
      throw new NotFoundException('Channel not found');
    }
    return channel;
  }

  async update(user: AuthUser, id: string, dto: UpdateChannelDto) {
    await this.findAccessible(user, id);
    if (dto.baseUrl) await this.assertSafeBaseUrl(dto.baseUrl);
    const channel = await this.prisma.channel.update({
      where: { id },
      data: {
        name: dto.name,
        provider: dto.provider,
        baseUrl: dto.baseUrl,
        models: dto.models,
        weight: dto.weight,
        priority: dto.priority,
        status: dto.status,
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
      );
    }
    const fresh = await this.prisma.channel.findUnique({
      where: { id },
      include: { modelPrices: true },
    });
    return this.view(fresh!);
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
          detail: safeStringify(e.body),
        };
      }
      return {
        ...base,
        status: 0,
        error: (e as Error)?.message ?? 'unknown error',
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
    await Promise.all(
      Array.from({ length: Math.min(concurrency, models.length) }, () => worker()),
    );
    const ok = results.filter((r) => r.ok).length;
    return {
      results,
      summary: { total: models.length, ok, failed: models.length - ok },
    };
  }

  /** 测试已保存渠道；不指定模型时测试该渠道全部模型。 */
  async testChannel(
    user: AuthUser,
    id: string,
    opts: { model?: string; models?: string[] } = {},
  ) {
    const channel = await this.findAccessible(user, id);
    let apiKey: string;
    try {
      apiKey = this.crypto.decrypt(channel.apiKeyEnc);
    } catch {
      throw new BadRequestException('渠道密钥无法解密，请重新填写上游 Key');
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
        throw new BadRequestException('请提供上游 API Key');
      }
      const channel = await this.findAccessible(user, dto.channelId);
      try {
        apiKey = this.crypto.decrypt(channel.apiKeyEnc);
      } catch {
        throw new BadRequestException('已存密钥无法解密，请重新填写');
      }
    }
    const models = this.resolveTestModels(dto, []);
    if (dto.baseUrl) await this.assertSafeBaseUrl(dto.baseUrl);
    return this.runUpstreamTests(
      { provider: dto.provider, baseUrl: dto.baseUrl, apiKey },
      models,
    );
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
      throw new BadRequestException('请提供用于测试的模型名');
    }
    return unique.slice(0, 20); // 单次测试上限，避免误操作
  }
}
