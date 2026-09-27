import { api } from './client';

let creditsPerUsd = 100;

export function getCreditsPerUsd(): number {
  return creditsPerUsd;
}

/** 拉取公共配置（积分汇率）；失败时用默认 100 */
export async function loadConfig(): Promise<void> {
  try {
    const { data } = await api.get<{ creditsPerUsd: number }>('/config');
    if (data?.creditsPerUsd) creditsPerUsd = Number(data.creditsPerUsd) || 100;
  } catch {
    /* keep default */
  }
}
