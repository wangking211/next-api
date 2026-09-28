import { api } from './client';

let creditsPerUsd = 100;
let creditsPerCny = 14.08;
let payEnabled = false;

export function getCreditsPerUsd(): number {
  return creditsPerUsd;
}

/** 每 1 元人民币可充入的积分（由后端 CREDITS_PER_USD / PAY_CNY_PER_USD 计算） */
export function getCreditsPerCny(): number {
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
      creditsPerCny?: number;
      payEnabled?: boolean;
    }>('/config');
    if (data?.creditsPerUsd) creditsPerUsd = Number(data.creditsPerUsd) || 100;
    if (data?.creditsPerCny) creditsPerCny = Number(data.creditsPerCny) || creditsPerCny;
    payEnabled = data?.payEnabled === true;
  } catch {
    /* keep default */
  }
}
