export interface UserInfo {
  id: string;
  email: string;
  username: string;
  role: 'USER' | 'ADMIN';
  createdAt: string;
}

export type ApiKeyStatus = 'ACTIVE' | 'DISABLED' | 'REVOKED';

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
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ApiKeyCreated extends ApiKeyInfo {
  plaintext: string;
  warning: string;
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
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  displayName: string;
  provider: string;
  inputPrice: string;
  outputPrice: string;
  enabled: boolean;
  createdAt: string;
}

export interface UsageSummary {
  rangeDays: number;
  requests: number;
  successRequests: number;
  errorRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: string;
}

export interface UsageDailyRow {
  date: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
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
  totals: { requests: number; errors: number; success: number; tokens: number; cost: number };
  byModel: { model: string; requests: number; tokens: number; cost: number; errors: number }[];
  byChannel: {
    channelId: string | null;
    name: string;
    provider: string;
    requests: number;
    tokens: number;
    cost: number;
  }[];
  byUser: { userId: string; name: string; requests: number; tokens: number; cost: number }[];
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type BalanceTxType = 'RECHARGE' | 'CONSUME' | 'ADJUST';

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

export interface AdminUser {
  id: string;
  email: string;
  username: string;
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'BANNED';
  balance: string;
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
