import { api } from './client';
import {
  ApiKeyCreated,
  ApiKeyInfo,
  AdminUser,
  AgentMember,
  AgentOverview,
  AuditLog,  AvailableChannelModels,
  BalanceTransaction,
  BalanceTxType,
  ChannelInfo,
  ChannelTestResult,
  CommonModel,
  GenerateCodesResult,
  LogFilters,
  ModelInfo,
  Paginated,
  PublicModelsResponse,
  PublicStats,
  RedeemCode,
  RedeemCodeStatus,
  RequestLogDetail,
  RequestLogRow,
  UsageAnalytics,
  UsageDailyRow,
  UsageSummary,
  UserInfo,
  Withdrawal,
} from './types';

export const authApi = {
  async login(identifier: string, password: string) {
    const { data } = await api.post<{ accessToken: string; user: UserInfo }>(
      '/auth/login',
      { identifier, password },
    );
    return data;
  },
  async register(email: string, username: string, password: string) {
    const { data } = await api.post<{ accessToken: string; user: UserInfo }>(
      '/auth/register',
      { email, username, password },
    );
    return data;
  },
  async me() {
    const { data } = await api.get<UserInfo>('/auth/me');
    return data;
  },
};

/** 无需登录的公开数据（落地页） */
export const publicApi = {
  async models(signal?: AbortSignal) {
    const { data } = await api.get<PublicModelsResponse>('/public/models', { signal });
    return data;
  },
  async stats(signal?: AbortSignal) {
    const { data } = await api.get<PublicStats>('/public/stats', { signal });
    return data;
  },
};

export const keysApi = {
  async list(signal?: AbortSignal) {
    const { data } = await api.get<ApiKeyInfo[]>('/keys', { signal });
    return data;
  },
  async create(body: {
    name: string;
    quotaLimit?: number;
    costLimit?: number;
    rpmLimit?: number;
    expiresAt?: string;
    /** 智能路由策略；留空跟随全局默认 */
    routingStrategy?: string;
  }) {
    const { data } = await api.post<ApiKeyCreated>('/keys', body);
    return data;
  },
  async update(
    id: string,
    body: Partial<{
      name: string;
      status: string;
      quotaLimit: number | null;
      costLimit: number | null;
      rpmLimit: number | null;
      routingStrategy: string | null;
    }>,
  ) {
    const { data } = await api.patch<ApiKeyInfo>(`/keys/${id}`, body);
    return data;
  },
  async remove(id: string) {
    await api.delete(`/keys/${id}`);
  },
};

export const channelsApi = {
  async list(
    params: {
      page?: number;
      pageSize?: number;
      name?: string;
      provider?: string;
      status?: string;
      ownerType?: string;
      model?: string;
    } = {},
    signal?: AbortSignal,
  ) {
    const { data } = await api.get<Paginated<ChannelInfo>>('/channels', { params, signal });
    return data;
  },
  async availableModels(signal?: AbortSignal) {
    const { data } = await api.get<AvailableChannelModels>('/channels/available-models', {
      signal,
    });
    return data;
  },
  async test(id: string, models?: string[]) {
    const { data } = await api.post<ChannelTestResult>(`/channels/${id}/test`, { models });
    return data;
  },
  async testConnection(body: {
    provider: string;
    baseUrl: string;
    model?: string;
    models?: string[];
    apiKey?: string;
    channelId?: string;
  }) {
    const { data } = await api.post<ChannelTestResult>('/channels/test-connection', body);
    return data;
  },
  async fetchModels(body: {
    provider: string;
    baseUrl?: string;
    apiKey?: string;
    channelId?: string;
  }) {
    const { data } = await api.post<{ models: string[]; total: number }>(
      '/channels/fetch-models',
      body,
    );
    return data;
  },
  async create(body: {
    name: string;
    provider: string;
    baseUrl: string;
    apiKey: string;
    models: string[];
    ownerType?: 'USER' | 'PLATFORM';
    weight?: number;
    priority?: number;
  }) {
    const { data } = await api.post<ChannelInfo>('/channels', body);
    return data;
  },
  async update(id: string, body: Partial<Record<string, unknown>>) {
    const { data } = await api.patch<ChannelInfo>(`/channels/${id}`, body);
    return data;
  },
  async remove(id: string) {
    await api.delete(`/channels/${id}`);
  },
};

export const modelsApi = {
  async list(signal?: AbortSignal) {
    const { data } = await api.get<ModelInfo[]>('/models', { signal });
    return data;
  },
  async suggestions(signal?: AbortSignal) {
    const { data } = await api.get<CommonModel[]>('/models/suggestions', { signal });
    return data;
  },
  async create(body: {
    name: string;
    displayName: string;
    provider: string;
    inputPrice?: number;
    outputPrice?: number;
    cacheReadPrice?: number;
    cacheWritePrice?: number;
    enabled?: boolean;
  }) {
    const { data } = await api.post<ModelInfo>('/models', body);
    return data;
  },
  async update(id: string, body: Partial<Record<string, unknown>>) {
    const { data } = await api.patch<ModelInfo>(`/models/${id}`, body);
    return data;
  },
  async remove(id: string) {
    await api.delete(`/models/${id}`);
  },
};

export const usageApi = {
  async summary(days = 30, scope?: 'all', signal?: AbortSignal, userId?: string) {
    const { data } = await api.get<UsageSummary>('/usage/summary', {
      params: { days, scope, userId },
      signal,
    });
    return data;
  },
  async daily(days = 30, scope?: 'all', signal?: AbortSignal, userId?: string) {
    const { data } = await api.get<UsageDailyRow[]>('/usage/daily', {
      params: { days, scope, userId },
      signal,
    });
    return data;
  },
  async analytics(
    days = 30,
    scope?: 'all',
    signal?: AbortSignal,
    userId?: string,
    from?: string,
    to?: string,
  ) {
    const { data } = await api.get<UsageAnalytics>('/usage/analytics', {
      params: { days, scope, userId, from, to },
      signal,
    });
    return data;
  },
  async logs(page = 1, pageSize = 20, scope?: 'all', filters: LogFilters = {}, signal?: AbortSignal) {
    const { data } = await api.get<Paginated<RequestLogRow>>('/usage/logs', {
      params: { page, pageSize, scope, ...filters },
      signal,
    });
    return data;
  },
  async logDetail(id: string, scope?: 'all', signal?: AbortSignal) {
    const { data } = await api.get<RequestLogDetail>(`/usage/logs/${id}`, {
      params: { scope },
      signal,
    });
    return data;
  },
  async exportLogs(
    params: { scope?: 'all' } & LogFilters,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const res = await api.get('/usage/logs/export', {
      params,
      responseType: 'blob',
      signal,
    });
    return res.data as Blob;
  },
};

export const billingApi = {
  async me(signal?: AbortSignal) {
    const { data } = await api.get<{ balance: number }>('/billing/me', { signal });
    return data;
  },
  async transactions(page = 1, pageSize = 20, type?: BalanceTxType, signal?: AbortSignal) {
    const { data } = await api.get<Paginated<BalanceTransaction>>(
      '/billing/transactions',
      { params: { page, pageSize, type }, signal },
    );
    return data;
  },
  async redeem(code: string) {
    const { data } = await api.post<{ balance: number; amount: number }>(
      '/billing/redeem',
      { code },
    );
    return data;
  },
};

export const adminApi = {
  async users(q?: string, page = 1, pageSize = 20, signal?: AbortSignal, role?: string) {
    const { data } = await api.get<Paginated<AdminUser>>('/admin/users', {
      params: { q, page, pageSize, role },
      signal,
    });
    return data;
  },
  async updateUser(
    id: string,
    body: {
      role?: string;
      priceMultiplier?: number | null;
      agentId?: string | null;
      rebateRate?: number | null;
    },
  ) {
    const { data } = await api.patch<AdminUser>(`/admin/users/${id}`, body);
    return data;
  },
  async recharge(id: string, amount: number, description?: string) {
    await api.post(`/admin/users/${id}/recharge`, { amount, description });
  },
  async adjust(id: string, amount: number, description?: string) {
    await api.post(`/admin/users/${id}/adjust`, { amount, description });
  },
};

export const redeemCodesApi = {
  async generate(body: {
    amount: number;
    quantity: number;
    note?: string;
    expiresAt?: string;
  }) {
    const { data } = await api.post<GenerateCodesResult>('/admin/redeem-codes', body);
    return data;
  },
  async list(page = 1, pageSize = 20, status?: RedeemCodeStatus, signal?: AbortSignal) {
    const { data } = await api.get<Paginated<RedeemCode>>('/admin/redeem-codes', {
      params: { page, pageSize, status },
      signal,
    });
    return data;
  },
  async disable(id: string) {
    const { data } = await api.patch<RedeemCode>(`/admin/redeem-codes/${id}/disable`);
    return data;
  },
};

export const auditApi = {
  async list(page = 1, pageSize = 20, action?: string, signal?: AbortSignal) {
    const { data } = await api.get<Paginated<AuditLog>>('/admin/audit-logs', {
      params: { page, pageSize, action },
      signal,
    });
    return data;
  },
};

export const agentApi = {
  async overview(signal?: AbortSignal) {
    const { data } = await api.get<AgentOverview>('/agent/overview', { signal });
    return data;
  },
  async members(signal?: AbortSignal) {
    const { data } = await api.get<AgentMember[]>('/agent/members', { signal });
    return data;
  },
  async createMember(body: { email: string; username: string; password: string }) {
    const { data } = await api.post('/agent/members', body);
    return data;
  },
  async rechargeMember(id: string, amountUsd: number) {
    const { data } = await api.post(`/agent/members/${id}/recharge`, {
      amount: amountUsd,
    });
    return data;
  },
};

export const withdrawalsApi = {
  async create(amountUsd: number, note?: string) {
    const { data } = await api.post<Withdrawal>('/withdrawals', {
      amount: amountUsd,
      note,
    });
    return data;
  },
  async mine(signal?: AbortSignal) {
    const { data } = await api.get<Withdrawal[]>('/withdrawals', { signal });
    return data;
  },
  async listAll(status?: string, signal?: AbortSignal) {
    const { data } = await api.get<Withdrawal[]>('/admin/withdrawals', {
      params: { status },
      signal,
    });
    return data;
  },
  async review(id: string, action: 'APPROVE' | 'REJECT') {
    const { data } = await api.patch<Withdrawal>(`/admin/withdrawals/${id}`, {
      action,
    });
    return data;
  },
};
