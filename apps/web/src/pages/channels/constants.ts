export type PriceRow = {
  costDiscount?: number;
  priceDiscount?: number;
};

export type SetPrice = (model: string, key: keyof PriceRow, value: number | null) => void;

export interface Filters {
  name?: string;
  provider?: string;
  status?: string;
  ownerType?: string;
  model?: string;
}

export const PROVIDERS = [
  { value: 'openai', label: 'OpenAI', placeholder: 'https://api.openai.com/v1' },
  { value: 'anthropic', label: 'Anthropic', placeholder: 'https://api.anthropic.com/v1' },
  { value: 'gemini', label: 'Google Gemini', placeholder: 'https://generativelanguage.googleapis.com/v1beta' },
  { value: 'deepseek', label: 'DeepSeek', placeholder: 'https://api.deepseek.com/v1' },
  { value: 'moonshot', label: 'Moonshot', placeholder: 'https://api.moonshot.cn/v1' },
  { value: 'qwen', label: 'Qwen (DashScope)', placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { value: 'zhipu', label: '智谱 GLM', placeholder: 'https://open.bigmodel.cn/api/paas/v4' },
  { value: 'custom', label: '自定义 (OpenAI 兼容)', placeholder: 'https://your-endpoint/v1' },
];
