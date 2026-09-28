import { api } from './client';

let creditsPerUsd = 100;
let payRate: number | null = null;
let creditsPerCny: number | null = null;
let payEnabled = false;

export function getCreditsPerUsd(): number {
  return creditsPerUsd;
}

/** 1 美元 = ? 元人民币（实时汇率或管理员固定值；不可用时为 null） */
export function getPayRate(): number | null {
  return payRate;
}

/** 每 1 元人民币可充入的积分（后端按汇率计算；汇率不可用时为 null） */
export function getCreditsPerCny(): number | null {
  return creditsPerCny;
}

/** 在线支付是否已开通（JAIPay 密钥齐全） */
export function isPayEnabled(): boolean {
  return payEnabled;
}

/** 拉取公共配置（积分汇率）；失败时用默认值 */
export async function loadConfig(): Promise<void> {
  try {
    const { data } = await api.get<{
      creditsPerUsd: number;
      creditsPerCny?: number | null;
      payRate?: number | null;
      payEnabled?: boolean;
    }>('/config');
    if (data?.creditsPerUsd) creditsPerUsd = Number(data.creditsPerUsd) || 100;
    creditsPerCny = data?.creditsPerCny != null ? Number(data.creditsPerCny) : null;
    payRate = data?.payRate != null ? Number(data.payRate) : null;
    payEnabled = data?.payEnabled === true;
  } catch {
    /* keep default */
  }
}
