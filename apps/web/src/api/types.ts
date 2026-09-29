export interface UserInfo {
  id: string;
  email: string;
  username: string;
  role: 'USER' | 'ADMIN' | 'AGENT';
  createdAt: string;
}

export type ApiKeyStatus = 'ACTIVE' | 'DISABLED' | 'REVOKED';

export type ModelGroupStatus = 'ENABLED' | 'DISABLED';

/** 模型产地 */
export type ModelOrigin = 'DOMESTIC' | 'OVERSEAS';

/** 分组简要信息（用户所属分组携带倍率） */
export interface GroupRef {
  id: string;
  name: string;
  displayName: string;
  ratio: number | null;
}

/** 分组简要信息（令牌 / 渠道关联，不含倍率） */
export interface GroupTag {
  id: string;
  name: string;
  displayName: string;
}

export interface ModelGroupCounts {
  models: number;
  users: number;
  apiKeys: number;
  channels: number;
}

export interface ModelGroup {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  /** 分组倍率；null = 不参与（回退用户/代理倍率） */
  ratio: number | null;
  status: ModelGroupStatus;
  priority: number;
  isDefault: boolean;
  /** 可见模型；空数组 = 不限制（全部可见） */
  models: string[];
  counts: ModelGroupCounts;
}

/** 智能路由策略（评分权重预设），null = 跟随全局默认 */
export type RoutingStrategy =
  | 'BALANCED'
  | 'CHEAPEST'
  | 'FASTEST'
  | 'STABLE'
  | 'QUALITY_FIRST';

export interface ApiKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  status: ApiKeyStatus;
  quotaLimit: number | null;
  quotaUsed: number;
  costLimit: string | null;
  costUsed: string;
  rpmLimit: number | null;
  routingStrategy: RoutingStrategy | null;
  tpmLimit: number | null;
  models: string[];
  groupId: string | null;
  group: GroupTag | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ApiKeyCreated extends ApiKeyInfo {
  plaintext: string;
  warning: string;
}

export interface ChannelModelPrice {
  model: string;
  /** 上游实际模型名（本地模型名 → 上游模型名映射） */
  upstreamModelName: string | null;
  costInput: number | null;
  costOutput: number | null;
  priceInput: number | null;
  priceOutput: number | null;
  /** 按次成本/售价（USD/次）：图片等非 token 计费模型 */
  costPerCall: number | null;
  pricePerCall: number | null;
  discount: number | null;
  costDiscount: number | null;
  priceDiscount: number | null;
  enabled: boolean;
  priority: number | null;
  weight: number | null;
  /** L1 人工质量分 0~2（1=正常），参与智能路由评分 */
  qualityScore: number | null;
}

export interface ChannelInfo {
  id: string;
  ownerType: 'PLATFORM' | 'USER';
  ownerUserId: string | null;
  name: string;
  provider: string;
  baseUrl: string;
  models: string[];
  weight: number;
  priority: number;
  status: 'ENABLED' | 'DISABLED';
  apiKeyPreview: string;
  hasApiKey: boolean;
  failureCount: number;
  autoDisabled: boolean;
  lastErrorAt: string | null;
  lastErrorMsg: string | null;
  /** 每日调用限额，null/0 = 不限；超限后智能路由排除该渠道 */
  dailyRequestLimit: number | null;
  /** 每日 token 限额，null/0 = 不限 */
  dailyTokenLimit: number | null;
  /** 渠道绑定的分组（仅管理员可设置） */
  groups: GroupTag[];
  /** 上游分组名（透传给上游的参数） */
  upstreamGroup: string | null;
  createdAt: string;
  modelPrices?: ChannelModelPrice[];
}

export interface ModelInfo {
  id: string;
  name: string;
  displayName: string;
  provider: string;
  origin: ModelOrigin;
  vendor: string | null;
  inputPrice: string;
  outputPrice: string;
  cacheReadPrice: string;
  cacheWritePrice: string;
  /** 按次价格（USD/次）；null = 按 token 计价 */
  perCallPrice: string | null;
  enabled: boolean;
  createdAt: string;
}

/** POST /api/models/classify-origins —— 一键归类结果 */
export interface ClassifyOriginsResult {
  total: number;
  updated: number;
  byOrigin: Record<string, number>;
  byVendor: Record<string, number>;
}

/** GET /api/public/models —— 落地页定价表（价格单位 $/1M tokens） */
export interface PublicModel {
  name: string;
  displayName: string;
  provider: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  cacheWritePrice: number;
}

export interface PublicModelsResponse {
  items: PublicModel[];
  providers: string[];
  count: number;
}

/** GET /api/public/stats —— 落地页数据条 */
export interface PublicStats {
  modelCount: number;
  providerCount: number;
  channelCount: number;
  protocolCount: number;
  protocols: string[];
}

export interface UsageSummary {
  rangeDays: number;
  requests: number;
  successRequests: number;
  errorRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 折算总额（含 BYOK 未计费的调用） */
  cost: string;
  /** 实际扣费（与余额扣款同口径），BYOK 调用为 0 */
  billedCost: string | number;
}

export interface UsageDailyRow {
  date: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 折算总额 */
  cost: number;
  /** 实际扣费（BYOK 调用为 0） */
  billedCost: number;
}

export interface RequestLogRow {
  id: string;
  model: string;
  provider: string | null;
  isStream: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: string;
  /** false = BYOK 自带密钥，未从余额扣费 */
  chargeable: boolean;
  latencyMs: number | null;
  status: number;
  errorMessage: string | null;
  createdAt: string;
  apiKey: { name: string; keyPrefix: string } | null;
  channel: { name: string; provider: string } | null;
}

export interface RequestLogDetail extends RequestLogRow {
  userId: string;
  requestPreview: string | null;
  responsePreview: string | null;
}

export interface LogFilters {
  model?: string;
  status?: 'success' | 'error';
  stream?: boolean;
  q?: string;
  from?: string;
  to?: string;
  userId?: string;
}

export interface UsageAnalytics {
  rangeDays: number;
  from: string;
  to: string;
  totals: {
    requests: number;
    errors: number;
    success: number;
    tokens: number;
    cost: number;
    billedCost: number;
    upstreamCost: number;
    billedUpstreamCost: number;
    margin: number;
  };
  byModel: {
    model: string;
    requests: number;
    tokens: number;
    cost: number;
    billedCost: number;
    upstreamCost: number;
    billedUpstreamCost: number;
    margin: number;
    errors: number;
  }[];
  byChannel: {
    channelId: string | null;
    name: string;
    provider: string;
    requests: number;
    tokens: number;
    cost: number;
    billedCost: number;
    upstreamCost: number;
    billedUpstreamCost: number;
    margin: number;
    /** status >= 400 的请求数 */
    errors: number;
    /** 平均耗时(ms) */
    avgLatency: number;
  }[];
  byUser: {
    userId: string;
    name: string;
    requests: number;
    tokens: number;
    cost: number;
    billedCost: number;
    upstreamCost: number;
    billedUpstreamCost: number;
    margin: number;
  }[];
  byApiKey: {
    apiKeyId: string | null;
    name: string;
    keyPrefix: string;
    requests: number;
    tokens: number;
    cost: number;
    billedCost: number;
    upstreamCost: number;
    billedUpstreamCost: number;
    margin: number;
  }[];
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type BalanceTxType =
  | 'RECHARGE'
  | 'CONSUME'
  | 'ADJUST'
  | 'COMMISSION'
  | 'TRANSFER'
  | 'WITHDRAW';

export interface BalanceTransaction {
  id: string;
  userId: string;
  type: BalanceTxType;
  amount: string;
  balanceAfter: string;
  description: string | null;
  operatorId: string | null;
  requestLogId: string | null;
  createdAt: string;
}

export type PaymentOrderStatus = 'PENDING' | 'PAID' | 'CLOSED' | 'FAILED';

/** 在线充值订单（微信/支付宝） */
export interface PaymentOrder {
  id: string;
  mchOrderNo: string;
  wayCode: string;
  channel: string | null;
  channelOrderNo: string | null;
  /** 人民币分 */
  amountCents: number;
  /** 入账额度（USD） */
  creditUsd: number;
  /** 入账积分 */
  credits: number;
  status: PaymentOrderStatus;
  paidAt: string | null;
  createdAt: string;
}

/** 下单响应：payDataType + payData（二维码内容 / 收银台链接 / 图片地址） */
export interface PaymentOrderCreated {
  id: string;
  mchOrderNo: string;
  amountCents: number;
  creditUsd: number;
  credits: number;
  wayCode: string;
  payDataType: string | null;
  payData: string | null;
  status: PaymentOrderStatus;
}

export interface AdminUser {
  id: string;
  email: string;
  username: string;
  role: 'USER' | 'ADMIN' | 'AGENT';
  status: 'ACTIVE' | 'BANNED';
  balance: string;
  priceMultiplier: string | null;
  rebateRate: string | null;
  agentId: string | null;
  agent: { id: string; username: string; priceMultiplier: string | null } | null;
  groupId: string | null;
  group: GroupRef | null;
  /** 最后活跃（由调用明细派生；null = 从未调用） */
  lastActiveAt: string | null;
  createdAt: string;
  _count: { apiKeys: number; channels: number };
}

export type RedeemCodeStatus = 'UNUSED' | 'USED' | 'DISABLED';

export interface RedeemCode {
  id: string;
  code: string;
  amount: string;
  status: RedeemCodeStatus;
  batchId: string | null;
  note: string | null;
  createdById: string | null;
  usedById: string | null;
  usedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface GenerateCodesResult {
  batchId: string;
  count: number;
  amount: number;
  codes: string[];
}

export interface AuditLog {
  id: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface AvailableChannelModels {
  channels: {
    id: string;
    name: string;
    ownerType: 'PLATFORM' | 'USER';
    provider: string;
    models: string[];
  }[];
  models: string[];
}

export interface ChannelTestItem {
  ok: boolean;
  status: number;
  latencyMs: number;
  model: string;
  provider: string;
  sample?: string;
  error?: string;
  detail?: string | null;
}

export interface ChannelTestResult {
  results: ChannelTestItem[];
  summary: { total: number; ok: number; failed: number };
}

export interface CommonModel {
  name: string;
  displayName: string;
  provider: string;
  inputPrice: number;
  outputPrice: number;
}

export interface AgentOverview {
  balance: number;
  rebateRate: number | null;
  priceMultiplier: number | null;
  memberCount: number;
  commissionTotal: number;
  membersUsage30d: { requests: number; tokens: number; cost: number };
}

export interface AgentMember {
  id: string;
  username: string;
  email: string;
  status: string;
  balance: number;
  priceMultiplier: number | null;
  createdAt: string;
  usage30d: { requests: number; tokens: number; cost: number };
}

export type WithdrawalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface Withdrawal {
  id: string;
  userId: string;
  amount: string;
  status: WithdrawalStatus;
  note: string | null;
  reviewedById: string | null;
  reviewedAt: string | null;
  createdAt: string;
  user?: { id: string; username: string; email: string };
}
