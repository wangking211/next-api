/**
 * 渠道×模型 定价派生（纯函数，无 IO）。
 *
 * 规则（与线上口径一致）：
 * - 成本 = 目录官方价 × costDiscount；售价 = 目录官方价 × priceDiscount；
 * - 渠道行上的绝对价格字段（priceInput/costInput/…）优先于折扣派生；
 * - 旧字段 `discount` 仅作为下游售价折扣兼容；
 * - 绝对字段全空 → `explicit = false`（表示该价来自目录默认价）。
 *
 * 拆成纯函数的意义：网关热路径（resolve/预授权/落账）可直接用已查出的
 * 渠道×模型行 + 缓存目录行本地派生，省掉每候选一次的 `getChannelPricing` 查询。
 */

export interface ChannelPricing {
  /** 对用户售价 USD/1M tokens */
  priceInput: number;
  priceOutput: number;
  /** 上游成本 USD/1M tokens */
  costInput: number;
  costOutput: number;
  /** 缓存读/写 售价与成本（USD/1M tokens） */
  cacheReadPrice: number;
  cacheWritePrice: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  /** 按次售价/成本（USD/次）：图片等非 token 计费模型 */
  pricePerCall: number;
  costPerCall: number;
  /** 是否来自渠道×模型显式定价（否则为目录默认价） */
  explicit: boolean;
}

/** 定价派生可接受的数值形态：number / 字符串 / Prisma Decimal（toString） */
export type NumLike = number | string | { toString(): string } | null | undefined;

/** 渠道×模型行的定价字段子集 */
export interface ChannelModelPricingRow {
  priceInput?: NumLike;
  priceOutput?: NumLike;
  costInput?: NumLike;
  costOutput?: NumLike;
  pricePerCall?: NumLike;
  costPerCall?: NumLike;
  discount?: NumLike;
  costDiscount?: NumLike;
  priceDiscount?: NumLike;
}

/** 目录行的定价字段子集 */
export interface CatalogPricingRow {
  inputPrice?: NumLike;
  outputPrice?: NumLike;
  cacheReadPrice?: NumLike;
  cacheWritePrice?: NumLike;
  perCallPrice?: NumLike;
}

const num = (v: NumLike): number => (v != null ? Number(v) : 0);

/** 按渠道×模型行 + 目录行派生完整定价；cm/catalog 均可为 null */
export function deriveChannelPricing(
  cm: ChannelModelPricingRow | null | undefined,
  catalog: CatalogPricingRow | null | undefined,
): ChannelPricing {
  const officialIn = num(catalog?.inputPrice);
  const officialOut = num(catalog?.outputPrice);
  const officialCacheRead = num(catalog?.cacheReadPrice);
  const officialCacheWrite = num(catalog?.cacheWritePrice);
  const officialPerCall = num(catalog?.perCallPrice);

  // 兼容旧 discount：仅作为下游售价折扣
  const priceDisc =
    cm?.priceDiscount != null
      ? Number(cm.priceDiscount)
      : cm?.discount != null
        ? Number(cm.discount)
        : 1;
  const costDisc = cm?.costDiscount != null ? Number(cm.costDiscount) : 1;

  const priceInput =
    cm?.priceInput != null ? Number(cm.priceInput) : officialIn * priceDisc;
  const priceOutput =
    cm?.priceOutput != null ? Number(cm.priceOutput) : officialOut * priceDisc;
  const costInput =
    cm?.costInput != null ? Number(cm.costInput) : officialIn * costDisc;
  const costOutput =
    cm?.costOutput != null ? Number(cm.costOutput) : officialOut * costDisc;
  const pricePerCall =
    cm?.pricePerCall != null ? Number(cm.pricePerCall) : officialPerCall * priceDisc;
  const costPerCall =
    cm?.costPerCall != null ? Number(cm.costPerCall) : officialPerCall * costDisc;

  return {
    priceInput,
    priceOutput,
    costInput,
    costOutput,
    cacheReadPrice: officialCacheRead * priceDisc,
    cacheWritePrice: officialCacheWrite * priceDisc,
    cacheReadCost: officialCacheRead * costDisc,
    cacheWriteCost: officialCacheWrite * costDisc,
    pricePerCall,
    costPerCall,
    explicit:
      cm?.priceInput != null ||
      cm?.priceOutput != null ||
      cm?.costInput != null ||
      cm?.costOutput != null ||
      cm?.pricePerCall != null ||
      cm?.costPerCall != null ||
      cm?.costDiscount != null ||
      cm?.priceDiscount != null ||
      cm?.discount != null,
  };
}
