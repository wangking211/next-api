import { api } from './client';
import {
  ApiKeyCreated,
  ApiKeyInfo,
  AdminUser,
  AuditLog,
  AvailableChannelModels,
  BalanceTransaction,
  BalanceTxType,
  ChannelInfo,
  ChannelTestResult,
  CommonModel,
  GenerateCodesResult,
  LogFilters,
  ModelInfo,
  Paginated,
  RedeemCode,
  RedeemCodeStatus,
  RequestLogDetail,
  RequestLogRow,
  UsageAnalytics,
  UsageDailyRow,
  UsageSummary,
  UserInfo,
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

export const keysApi = {
  async list() {
    const { data } = await api.get<ApiKeyInfo[]>('/keys');
    return data;
  },
  async create(body: {
    name: string;
    quotaLimit?: number;
    costLimit?: number;
    rpmLimit?: number;
    expiresAt?: string;
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
  ) {
    const { data } = await api.get<Paginated<ChannelInfo>>('/channels', { params });
    return data;
  },
  async availableModels() {
    const { data } = await api.get<AvailableChannelModels>('/channels/available-models');
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
  async list() {
    const { data } = await api.get<ModelInfo[]>('/models');
    return data;
  },
  async suggestions() {
    const { data } = await api.get<CommonModel[]>('/models/suggestions');
    return data;
  },
  async create(body: {
    name: string;
    displayName: string;
    provider: string;
    inputPrice?: number;
    outputPrice?: number;
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
  async summary(days = 30, scope?: 'all') {
    const { data } = await api.get<UsageSummary>('/usage/summary', {
      params: { days, scope },
    });
    return data;
  },
  async daily(days = 30, scope?: 'all') {
    const { data } = await api.get<UsageDailyRow[]>('/usage/daily', {
      params: { days, scope },
    });
    return data;
  },
  async analytics(days = 30, scope?: 'all') {
    const { data } = await api.get<UsageAnalytics>('/usage/analytics', {
      params: { days, scope },
    });
    return data;
  },
  async logs(page = 1, pageSize = 20, scope?: 'all', filters: LogFilters = {}) {
    const { data } = await api.get<Paginated<RequestLogRow>>('/usage/logs', {
      params: { page, pageSize, scope, ...filters },
    });
    return data;
  },
  async logDetail(id: string, scope?: 'all') {
    const { data } = await api.get<RequestLogDetail>(`/usage/logs/${id}`, {
      params: { scope },
    });
    return data;
  },
};

export const billingApi = {
  async me() {
    const { data } = await api.get<{ balance: number }>('/billing/me');
    return data;
  },
  async transactions(page = 1, pageSize = 20, type?: BalanceTxType) {
    const { data } = await api.get<Paginated<BalanceTransaction>>(
      '/billing/transactions',
      { params: { page, pageSize, type } },
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
  async users(q?: string, page = 1, pageSize = 20) {
    const { data } = await api.get<Paginated<AdminUser>>('/admin/users', {
      params: { q, page, pageSize },
    });
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
  async list(page = 1, pageSize = 20, status?: RedeemCodeStatus) {
    const { data } = await api.get<Paginated<RedeemCode>>('/admin/redeem-codes', {
      params: { page, pageSize, status },
    });
    return data;
  },
  async disable(id: string) {
    const { data } = await api.patch<RedeemCode>(`/admin/redeem-codes/${id}/disable`);
    return data;
  },
};

export const auditApi = {
  async list(page = 1, pageSize = 20, action?: string) {
    const { data } = await api.get<Paginated<AuditLog>>('/admin/audit-logs', {
      params: { page, pageSize, action },
    });
    return data;
  },
};
