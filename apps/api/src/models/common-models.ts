/**
 * 内置主流模型目录（仅作为默认建议与初始定价）。
 * 价格为 USD / 1M tokens 的近似值，随官方调整会变化，请以「模型」页实际维护为准。
 */
export interface CommonModel {
  name: string;
  displayName: string;
  provider: string;
  inputPrice: number;
  outputPrice: number;
}

export const COMMON_MODELS: CommonModel[] = [
  // ---- 新一代 / 未来型号（占位定价，请按上游实际价目调整）----
  { name: 'gpt-5.6', displayName: 'GPT-5.6', provider: 'openai', inputPrice: 1.75, outputPrice: 14 },
  { name: 'gpt-5.5', displayName: 'GPT-5.5', provider: 'openai', inputPrice: 1.5, outputPrice: 12 },
  { name: 'gpt-6', displayName: 'GPT-6', provider: 'openai', inputPrice: 2.5, outputPrice: 15 },
  { name: 'claude-opus-5.5', displayName: 'Claude Opus 5.5', provider: 'anthropic', inputPrice: 15, outputPrice: 75 },
  { name: 'claude-opus-5', displayName: 'Claude Opus 5', provider: 'anthropic', inputPrice: 15, outputPrice: 75 },
  { name: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', provider: 'anthropic', inputPrice: 3, outputPrice: 15 },
  { name: 'claude-haiku-5', displayName: 'Claude Haiku 5', provider: 'anthropic', inputPrice: 1, outputPrice: 5 },
  { name: 'claude-fable-5', displayName: 'Claude Fable 5', provider: 'anthropic', inputPrice: 3, outputPrice: 15 },
  { name: 'gemini-3-pro', displayName: 'Gemini 3 Pro', provider: 'gemini', inputPrice: 1.5, outputPrice: 12 },
  { name: 'gemini-3-flash', displayName: 'Gemini 3 Flash', provider: 'gemini', inputPrice: 0.35, outputPrice: 3 },

  // ---- OpenAI ----
  { name: 'gpt-5', displayName: 'GPT-5', provider: 'openai', inputPrice: 1.25, outputPrice: 10 },
  { name: 'gpt-5-mini', displayName: 'GPT-5 mini', provider: 'openai', inputPrice: 0.25, outputPrice: 2 },
  { name: 'gpt-5-nano', displayName: 'GPT-5 nano', provider: 'openai', inputPrice: 0.05, outputPrice: 0.4 },
  { name: 'gpt-4.1', displayName: 'GPT-4.1', provider: 'openai', inputPrice: 2, outputPrice: 8 },
  { name: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini', provider: 'openai', inputPrice: 0.4, outputPrice: 1.6 },
  { name: 'gpt-4.1-nano', displayName: 'GPT-4.1 nano', provider: 'openai', inputPrice: 0.1, outputPrice: 0.4 },
  { name: 'gpt-4o', displayName: 'GPT-4o', provider: 'openai', inputPrice: 2.5, outputPrice: 10 },
  { name: 'gpt-4o-mini', displayName: 'GPT-4o mini', provider: 'openai', inputPrice: 0.15, outputPrice: 0.6 },
  { name: 'o3', displayName: 'o3', provider: 'openai', inputPrice: 2, outputPrice: 8 },
  { name: 'o4-mini', displayName: 'o4-mini', provider: 'openai', inputPrice: 1.1, outputPrice: 4.4 },

  // ---- Anthropic ----
  { name: 'claude-opus-4-1', displayName: 'Claude Opus 4.1', provider: 'anthropic', inputPrice: 15, outputPrice: 75 },
  { name: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', provider: 'anthropic', inputPrice: 3, outputPrice: 15 },
  { name: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', provider: 'anthropic', inputPrice: 1, outputPrice: 5 },
  { name: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet', provider: 'anthropic', inputPrice: 3, outputPrice: 15 },
  { name: 'claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet', provider: 'anthropic', inputPrice: 3, outputPrice: 15 },
  { name: 'claude-3-5-haiku', displayName: 'Claude 3.5 Haiku', provider: 'anthropic', inputPrice: 0.8, outputPrice: 4 },

  // ---- Google Gemini ----
  { name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', provider: 'gemini', inputPrice: 1.25, outputPrice: 10 },
  { name: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', provider: 'gemini', inputPrice: 0.3, outputPrice: 2.5 },
  { name: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', provider: 'gemini', inputPrice: 0.1, outputPrice: 0.4 },
  { name: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro', provider: 'gemini', inputPrice: 1.25, outputPrice: 5 },
  { name: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash', provider: 'gemini', inputPrice: 0.075, outputPrice: 0.3 },

  // ---- DeepSeek ----
  { name: 'deepseek-chat', displayName: 'DeepSeek Chat (V3)', provider: 'deepseek', inputPrice: 0.27, outputPrice: 1.1 },
  { name: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner (R1)', provider: 'deepseek', inputPrice: 0.55, outputPrice: 2.19 },

  // ---- Moonshot / Kimi ----
  { name: 'moonshot-v1-8k', displayName: 'Moonshot v1 8K', provider: 'moonshot', inputPrice: 1.7, outputPrice: 1.7 },
  { name: 'moonshot-v1-32k', displayName: 'Moonshot v1 32K', provider: 'moonshot', inputPrice: 3.4, outputPrice: 3.4 },
  { name: 'moonshot-v1-128k', displayName: 'Moonshot v1 128K', provider: 'moonshot', inputPrice: 8.5, outputPrice: 8.5 },
  { name: 'kimi-latest', displayName: 'Kimi Latest', provider: 'moonshot', inputPrice: 2, outputPrice: 2 },

  // ---- Alibaba Qwen ----
  { name: 'qwen-max', displayName: 'Qwen Max', provider: 'qwen', inputPrice: 1.6, outputPrice: 6.4 },
  { name: 'qwen-plus', displayName: 'Qwen Plus', provider: 'qwen', inputPrice: 0.4, outputPrice: 1.2 },
  { name: 'qwen-turbo', displayName: 'Qwen Turbo', provider: 'qwen', inputPrice: 0.05, outputPrice: 0.2 },
  { name: 'qwen3-235b-a22b', displayName: 'Qwen3 235B A22B', provider: 'qwen', inputPrice: 0.7, outputPrice: 2.8 },
  { name: 'qwen2.5-72b-instruct', displayName: 'Qwen2.5 72B', provider: 'qwen', inputPrice: 0.4, outputPrice: 1.2 },

  // ---- Zhipu GLM ----
  { name: 'glm-4.6', displayName: 'GLM-4.6', provider: 'zhipu', inputPrice: 0.6, outputPrice: 2.2 },
  { name: 'glm-4.5', displayName: 'GLM-4.5', provider: 'zhipu', inputPrice: 0.6, outputPrice: 2.2 },
  { name: 'glm-4-plus', displayName: 'GLM-4-Plus', provider: 'zhipu', inputPrice: 7, outputPrice: 7 },
  { name: 'glm-4-air', displayName: 'GLM-4-Air', provider: 'zhipu', inputPrice: 0.14, outputPrice: 0.14 },
  { name: 'glm-4-flash', displayName: 'GLM-4-Flash', provider: 'zhipu', inputPrice: 0, outputPrice: 0 },

  // ---- xAI Grok ----
  { name: 'grok-4', displayName: 'Grok 4', provider: 'xai', inputPrice: 3, outputPrice: 15 },
  { name: 'grok-3', displayName: 'Grok 3', provider: 'xai', inputPrice: 3, outputPrice: 15 },
  { name: 'grok-3-mini', displayName: 'Grok 3 mini', provider: 'xai', inputPrice: 0.3, outputPrice: 0.5 },

  // ---- Mistral ----
  { name: 'mistral-large-latest', displayName: 'Mistral Large', provider: 'mistral', inputPrice: 2, outputPrice: 6 },
  { name: 'mistral-small-latest', displayName: 'Mistral Small', provider: 'mistral', inputPrice: 0.2, outputPrice: 0.6 },

  // ---- ByteDance Doubao ----
  { name: 'doubao-1.5-pro-32k', displayName: 'Doubao 1.5 Pro 32K', provider: 'doubao', inputPrice: 0.11, outputPrice: 0.28 },
  { name: 'doubao-pro-32k', displayName: 'Doubao Pro 32K', provider: 'doubao', inputPrice: 0.11, outputPrice: 0.28 },

  // ---- MiniMax ----
  { name: 'minimax-text-01', displayName: 'MiniMax Text 01', provider: 'minimax', inputPrice: 0.2, outputPrice: 1.1 },
  { name: 'abab6.5s-chat', displayName: 'abab6.5s-chat', provider: 'minimax', inputPrice: 0.14, outputPrice: 0.14 },
];
