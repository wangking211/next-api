/**
 * 渠道×模型 定价派生（纯函数，无 IO）。
 *
 * 规则（与线上口径一致）：
 * - 成本 = 目录官方价 × costDiscount；售价 = 目录官方价 × priceDiscount；
 * - 渠道行上的绝对价格字段（priceInput/costInput/…）优先于折扣派生；
 * - 旧字段 `discount` 仅作为下游售价折扣兼容；
 * - 低谷期（由 `isPeakTime` 判定）且目录配置了 `offPeakMultiplier` → 成本/售价统一乘系数；
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
  /** 低谷价倍率（0~1）；null/1 = 无峰谷差异 */
  offPeakMultiplier?: NumLike;
}

const num = (v: NumLike): number => (v != null ? Number(v) : 0);

/** 峰段窗口解析：'01:00-04:00,06:00-10:00'（UTC；支持跨午夜如 22:00-02:00） */
function parsePeakWindows(windows: string): { start: number; end: number }[] {
  const toMin = (t: string): number => {
    const [h, m] = t.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  return windows
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((w) => {
      const [a, b] = w.split('-');
      return { start: toMin(a ?? ''), end: toMin(b ?? '') };
    })
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.start !== w.end);
}

/** 周几集合解析：'1-5' / '1,7'（ISO：1=周一 … 7=周日）；空 = 每天 */
function parseWeekdays(spec: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      for (let d = Math.min(a, b); d <= Math.max(a, b); d++) if (d >= 1 && d <= 7) out.add(d);
    } else {
      const d = Number(part);
      if (d >= 1 && d <= 7) out.add(d);
    }
  }
  return out;
}

/**
 * 当前是否处于「峰段」——峰段用目录基准价，低谷用 `offPeakMultiplier` 折扣价。
 * - windows 为空 → 永远峰段（等价于关闭峰谷计价，保持旧行为）
 * - holidays（YYYY-MM-DD，UTC 日期，逗号分隔）命中 → 全天低谷
 * - weekdays 为空 → 每天适用
 */
export function isPeakTime(
  at: Date,
  windows: string,
  weekdays: string,
  holidays: readonly string[] = [],
): boolean {
  const slots = parsePeakWindows(windows);
  if (!slots.length) return true;
  const isoDay = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
  const days = parseWeekdays(weekdays);
  if (days.size && !days.has(isoDay)) return false;
  const dateKey = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(
    at.getUTCDate(),
  ).padStart(2, '0')}`;
  if (holidays.includes(dateKey)) return false;
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  return slots.some((w) =>
    w.end > w.start ? minutes >= w.start && minutes < w.end : minutes >= w.start || minutes < w.end,
  );
}

/** 按渠道×模型行 + 目录行派生完整定价；cm/catalog 均可为 null */
export function deriveChannelPricing(
  cm: ChannelModelPricingRow | null | undefined,
  catalog: CatalogPricingRow | null | undefined,
  opts: { offPeak?: boolean } = {},
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

  const priceInput = cm?.priceInput != null ? Number(cm.priceInput) : officialIn * priceDisc;
  const priceOutput = cm?.priceOutput != null ? Number(cm.priceOutput) : officialOut * priceDisc;
  const costInput = cm?.costInput != null ? Number(cm.costInput) : officialIn * costDisc;
  const costOutput = cm?.costOutput != null ? Number(cm.costOutput) : officialOut * costDisc;
  const pricePerCall =
    cm?.pricePerCall != null ? Number(cm.pricePerCall) : officialPerCall * priceDisc;
  const costPerCall = cm?.costPerCall != null ? Number(cm.costPerCall) : officialPerCall * costDisc;

  const base: ChannelPricing = {
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

  // 低谷期：目录配置了 offPeakMultiplier（0~1）时，成本与售价统一乘该系数。
  // 显式渠道定价同样按峰值口径存储，低谷时一起打折，保证毛利结构一致。
  const m = num(catalog?.offPeakMultiplier);
  const factor = opts.offPeak && m > 0 && m < 1 ? m : 1;
  if (factor === 1) return base;
  return {
    ...base,
    priceInput: base.priceInput * factor,
    priceOutput: base.priceOutput * factor,
    costInput: base.costInput * factor,
    costOutput: base.costOutput * factor,
    cacheReadPrice: base.cacheReadPrice * factor,
    cacheWritePrice: base.cacheWritePrice * factor,
    cacheReadCost: base.cacheReadCost * factor,
    cacheWriteCost: base.cacheWriteCost * factor,
    pricePerCall: base.pricePerCall * factor,
    costPerCall: base.costPerCall * factor,
  };
}
