import i18n from '../../i18n';

export type PriceRow = {
  costDiscount?: number;
  priceDiscount?: number;
  /** L1 人工质量分 0~2（1=正常） */
  qualityScore?: number;
  /** 上游实际模型名（本地模型名 → 上游模型名映射） */
  upstreamModelName?: string;
  /** 按次成本 / 按次售价（USD/次）：图片等非 token 计费模型 */
  costPerCall?: number;
  pricePerCall?: number;
};

export type SetPrice = (model: string, key: keyof PriceRow, value: number | string | null) => void;

export interface Filters {
  name?: string;
  provider?: string;
  status?: string;
  ownerType?: string;
  model?: string;
}

// label 为函数：模块顶层不能求值 i18n.t（会冻结在导入时），由调用方在渲染期调用
export const PROVIDERS = [
  { value: 'openai', label: () => 'OpenAI', placeholder: 'https://api.openai.com/v1' },
  { value: 'anthropic', label: () => 'Anthropic', placeholder: 'https://api.anthropic.com/v1' },
  { value: 'gemini', label: () => 'Google Gemini', placeholder: 'https://generativelanguage.googleapis.com/v1beta' },
  { value: 'deepseek', label: () => 'DeepSeek', placeholder: 'https://api.deepseek.com/v1' },
  { value: 'moonshot', label: () => 'Moonshot', placeholder: 'https://api.moonshot.cn/v1' },
  { value: 'qwen', label: () => 'Qwen (DashScope)', placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { value: 'zhipu', label: () => i18n.t('channels.provider.zhipu'), placeholder: 'https://open.bigmodel.cn/api/paas/v4' },
  { value: 'custom', label: () => i18n.t('channels.provider.custom'), placeholder: 'https://your-endpoint/v1' },
];
