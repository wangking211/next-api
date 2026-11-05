import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModelOrigin, PriceCurrency, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TtlCacheService } from '../common/ttl-cache.service';
import { CreateModelDto } from './dto/create-model.dto';
import { UpdateModelDto } from './dto/update-model.dto';
import { COMMON_MODELS } from './common-models';
import { inferVendorOrigin } from './origin.util';

/** 价格字段：DTO 名 → officialPrices 原币价键（记账本位列恒为 USD） */
const PRICE_FIELDS = [
  ['inputPrice', 'input'],
  ['outputPrice', 'output'],
  ['cacheReadPrice', 'cacheRead'],
  ['cacheWritePrice', 'cacheWrite'],
  ['perCallPrice', 'perCall'],
] as const;
type OfficialKey = (typeof PRICE_FIELDS)[number][1];
type OfficialPrices = Partial<Record<OfficialKey, number | null>>;

/** 官方原币价 → USD 记账本位（CNY 按录入时汇率快照折算），对齐 Decimal(18,6) 6 位小数 */
function officialToUsd(official: number, currency: PriceCurrency, fxRate: number | null): number {
  if (currency !== 'CNY') return official;
  return Math.round((official / (fxRate as number)) * 1e6) / 1e6;
}

function readOfficialPrices(raw: unknown): OfficialPrices {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as OfficialPrices) }
    : {};
}

@Injectable()
export class ModelsService {
  constructor(
    private readonly prisma: PrismaService,
    // 网关热路径共享的模型目录快照；测试手工构造时未传 → 仅跳过失效动作
    @Optional() private readonly cache?: TtlCacheService,
  ) {}

  /** 目录写路径：失效网关共享的 `catalog:*` 快照（TTL 兜底：旁路改库 60s 后收敛） */
  private invalidateCatalog() {
    this.cache?.invalidate('catalog:');
  }

  /** CNY 录入必须有汇率快照（1 USD = N CNY）；USD 记账无需汇率 → null */
  private resolveFxRate(
    currency: PriceCurrency,
    dtoRate: number | undefined,
    existingRate: number | null,
  ): number | null {
    if (currency !== 'CNY') return null;
    const rate = dtoRate ?? existingRate;
    if (rate == null || !Number.isFinite(rate) || rate <= 0) {
      throw new BadRequestException({
        code: 'MODEL_FX_RATE_REQUIRED',
        message: 'priceCurrency=CNY requires fxRate (1 USD = N CNY)',
      });
    }
    return rate;
  }

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

  async create(dto: CreateModelDto) {
    const inferred = inferVendorOrigin(dto.name);
    const currency = dto.priceCurrency ?? PriceCurrency.USD;
    const fxRate = this.resolveFxRate(currency, dto.fxRate, null);
    const official: OfficialPrices = {
      input: dto.inputPrice ?? 0,
      output: dto.outputPrice ?? 0,
      cacheRead: dto.cacheReadPrice ?? 0,
      cacheWrite: dto.cacheWritePrice ?? 0,
      perCall: dto.perCallPrice ?? null,
    };
    const row = await this.prisma.modelCatalog.create({
      data: {
        name: dto.name,
        displayName: dto.displayName,
        provider: dto.provider,
        origin: dto.origin ?? inferred.origin,
        vendor: dto.vendor ?? inferred.vendor,
        inputPrice: officialToUsd(official.input ?? 0, currency, fxRate),
        outputPrice: officialToUsd(official.output ?? 0, currency, fxRate),
        cacheReadPrice: officialToUsd(official.cacheRead ?? 0, currency, fxRate),
        cacheWritePrice: officialToUsd(official.cacheWrite ?? 0, currency, fxRate),
        perCallPrice:
          official.perCall == null ? null : officialToUsd(official.perCall, currency, fxRate),
        priceCurrency: currency,
        fxRate,
        officialPrices: official as Prisma.InputJsonValue,
        capabilities: dto.capabilities ?? [],
        aliases: dto.aliases ?? [],
        offPeakMultiplier: dto.offPeakMultiplier ?? null,
        enabled: dto.enabled ?? true,
      },
    });
    this.invalidateCatalog();
    return row;
  }

  /**
   * 一键归类：按模型名批量推断 vendor / origin 并落库（管理员手动触发）。
   * 会覆盖已保存的 origin/vendor，用于历史数据补标。
   */
  async classifyOrigins() {
    const rows = await this.prisma.modelCatalog.findMany({
      select: { id: true, name: true, vendor: true, origin: true },
    });
    let updated = 0;
    const byOrigin: Record<string, number> = { DOMESTIC: 0, OVERSEAS: 0 };
    const byVendor: Record<string, number> = {};
    // 按 (vendor, origin) 分组批量落库：模型种类有限 → 查询数与表规模无关
    const pending = new Map<
      string,
      { vendor: string | null; origin: ModelOrigin; ids: string[] }
    >();
    for (const r of rows) {
      const { vendor, origin } = inferVendorOrigin(r.name);
      byOrigin[origin] = (byOrigin[origin] ?? 0) + 1;
      byVendor[vendor ?? 'unknown'] = (byVendor[vendor ?? 'unknown'] ?? 0) + 1;
      if (r.vendor !== vendor || r.origin !== origin) {
        const key = `${origin}|${vendor ?? ''}`;
        const bucket = pending.get(key) ?? { vendor, origin, ids: [] };
        bucket.ids.push(r.id);
        pending.set(key, bucket);
        updated++;
      }
    }
    for (const { vendor, origin, ids } of pending.values()) {
      // vendor 为 undefined 时 Prisma 跳过该字段（与原逐行 update 语义一致）
      await this.prisma.modelCatalog.updateMany({
        where: { id: { in: ids } },
        data: { vendor, origin },
      });
    }
    if (updated > 0) this.invalidateCatalog();
    return { total: rows.length, updated, byOrigin, byVendor };
  }

  async update(id: string, dto: UpdateModelDto) {
    const exists = await this.prisma.modelCatalog.findUnique({ where: { id } });
    if (!exists)
      throw new NotFoundException({
        code: 'MODEL_NOT_FOUND',
        message: 'Model not found',
      });
    const {
      inputPrice,
      outputPrice,
      cacheReadPrice,
      cacheWritePrice,
      perCallPrice,
      priceCurrency: dtoCurrency,
      fxRate: dtoFxRate,
      ...passthrough
    } = dto;
    const currency = dtoCurrency ?? (exists.priceCurrency as PriceCurrency) ?? PriceCurrency.USD;
    const existingRate = exists.fxRate == null ? null : Number(exists.fxRate);
    const priceTouched = PRICE_FIELDS.some(([k]) => dto[k] !== undefined);
    const currencyChanged = dtoCurrency !== undefined && dtoCurrency !== exists.priceCurrency;
    const rateChanged = dtoFxRate !== undefined && dtoFxRate !== existingRate;
    // 币种/汇率决定整套官方价的折算基准：变更必须携带全套官方价，避免原币价跨基准错读
    if ((currencyChanged || rateChanged) && !PRICE_FIELDS.every(([k]) => dto[k] !== undefined)) {
      throw new BadRequestException({
        code: 'MODEL_PRICE_SET_REQUIRED',
        message: 'Changing priceCurrency/fxRate requires the full official price set',
      });
    }
    const fxRate = this.resolveFxRate(currency, dtoFxRate, existingRate);

    const data: Record<string, unknown> = { ...passthrough };
    if (dtoCurrency !== undefined) data.priceCurrency = currency;
    if (dtoFxRate !== undefined || currencyChanged) data.fxRate = fxRate;
    if (priceTouched || currencyChanged || rateChanged) {
      const official = readOfficialPrices(exists.officialPrices);
      const put = (key: OfficialKey, dtoValue: number | null | undefined, column: string) => {
        if (dtoValue === undefined) return;
        official[key] = dtoValue;
        data[column] = dtoValue == null ? null : officialToUsd(dtoValue, currency, fxRate);
      };
      put('input', inputPrice, 'inputPrice');
      put('output', outputPrice, 'outputPrice');
      put('cacheRead', cacheReadPrice, 'cacheReadPrice');
      put('cacheWrite', cacheWritePrice, 'cacheWritePrice');
      put('perCall', perCallPrice, 'perCallPrice');
      data.officialPrices = official;
    }
    const row = await this.prisma.modelCatalog.update({
      where: { id },
      data: data as Prisma.ModelCatalogUpdateInput,
    });
    this.invalidateCatalog();
    return row;
  }

  async remove(id: string) {
    const exists = await this.prisma.modelCatalog.findUnique({ where: { id } });
    if (!exists)
      throw new NotFoundException({
        code: 'MODEL_NOT_FOUND',
        message: 'Model not found',
      });
    await this.prisma.modelCatalog.delete({ where: { id } });
    this.invalidateCatalog();
    return { success: true };
  }
}
