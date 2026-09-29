import { ModelOrigin } from '@prisma/client';

/**
 * 模型厂商 / 产地识别规则（自上而下首个命中）。
 * 用途：模型目录自动打标（vendor + origin），支持控制台「一键归类」。
 * 注意：产地以「模型厂商」为准，与调用链路（Channel.region）无关。
 */
const VENDOR_RULES: { re: RegExp; vendor: string; origin: ModelOrigin }[] = [
  { re: /^(claude|anthropic)/i, vendor: 'anthropic', origin: ModelOrigin.OVERSEAS },
  {
    re: /^(gpt|chatgpt|dall-?e|sora|o[1-9]([._-]|$)|text-embedding|whisper|tts-)/i,
    vendor: 'openai',
    origin: ModelOrigin.OVERSEAS,
  },
  {
    re: /^(gemini|gemma|nano-banana|imagen|veo|palm)/i,
    vendor: 'google',
    origin: ModelOrigin.OVERSEAS,
  },
  { re: /^(grok|xai)/i, vendor: 'xai', origin: ModelOrigin.OVERSEAS },
  { re: /^(llama|meta-)/i, vendor: 'meta', origin: ModelOrigin.OVERSEAS },
  { re: /^(mistral|mixtral|codestral|pixtral|magistral)/i, vendor: 'mistral', origin: ModelOrigin.OVERSEAS },
  { re: /^(cohere|command-)/i, vendor: 'cohere', origin: ModelOrigin.OVERSEAS },
  // ---- 国产厂商 ----
  { re: /^deepseek/i, vendor: 'deepseek', origin: ModelOrigin.DOMESTIC },
  { re: /^(kimi|moonshot)/i, vendor: 'moonshot', origin: ModelOrigin.DOMESTIC },
  { re: /^(glm|chatglm|cogvlm|zhipu)/i, vendor: 'zhipu', origin: ModelOrigin.DOMESTIC },
  { re: /^(qwen|qwq|qvq|tongyi|wanx|wan-?x|wan2)/i, vendor: 'alibaba', origin: ModelOrigin.DOMESTIC },
  { re: /^(minimax|abab)/i, vendor: 'minimax', origin: ModelOrigin.DOMESTIC },
  { re: /^kling/i, vendor: 'kuaishou', origin: ModelOrigin.DOMESTIC },
  { re: /^(doubao|volc|seedream|seedance|skylark)/i, vendor: 'volcengine', origin: ModelOrigin.DOMESTIC },
  { re: /^(ernie|wenxin)/i, vendor: 'baidu', origin: ModelOrigin.DOMESTIC },
  { re: /^hunyuan/i, vendor: 'tencent', origin: ModelOrigin.DOMESTIC },
  { re: /^(spark|generalv)/i, vendor: 'iflytek', origin: ModelOrigin.DOMESTIC },
  { re: /^(step-|stepfun)/i, vendor: 'stepfun', origin: ModelOrigin.DOMESTIC },
  { re: /^baichuan/i, vendor: 'baichuan', origin: ModelOrigin.DOMESTIC },
  { re: /^(yi-|01-ai)/i, vendor: '01ai', origin: ModelOrigin.DOMESTIC },
];

/** 按模型名推断厂商与产地；未知厂商按海外处理（保守：漏标的国产模型只会少暴露，不会误放行海外模型） */
export function inferVendorOrigin(name: string): { vendor: string | null; origin: ModelOrigin } {
  const n = (name ?? '').trim();
  for (const r of VENDOR_RULES) {
    if (r.re.test(n)) return { vendor: r.vendor, origin: r.origin };
  }
  return { vendor: null, origin: ModelOrigin.OVERSEAS };
}
