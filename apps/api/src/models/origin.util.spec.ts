import { ModelOrigin } from '@prisma/client';
import { inferVendorOrigin } from './origin.util';

describe('inferVendorOrigin', () => {
  const overseas: [string, string][] = [
    ['claude-opus-4-7', 'anthropic'],
    ['claude-fable-5-1', 'anthropic'],
    ['gpt-5.5', 'openai'],
    ['gpt-image-2', 'openai'],
    ['sora-2', 'openai'],
    ['gemini-3.5-flash', 'google'],
    ['nano-banana-2', 'google'],
    ['grok-4.20', 'xai'],
    ['mistral-large', 'mistral'],
  ];
  const domestic: [string, string][] = [
    ['deepseek-v3.2', 'deepseek'],
    ['deepseek-v4-flash', 'deepseek'],
    ['kimi-k2.7', 'moonshot'],
    ['kimi-k3', 'moonshot'],
    ['MiniMax-M3', 'minimax'],
    ['glm-4.7', 'zhipu'],
    ['qwen3-max', 'alibaba'],
    ['kling-v2-6', 'kuaishou'],
    ['doubao-pro-32k', 'volcengine'],
    ['ernie-4.5', 'baidu'],
    ['hunyuan-turbo', 'tencent'],
  ];

  it.each(overseas)('%s → %s / OVERSEAS', (name, vendor) => {
    expect(inferVendorOrigin(name)).toEqual({ vendor, origin: ModelOrigin.OVERSEAS });
  });

  it.each(domestic)('%s → %s / DOMESTIC', (name, vendor) => {
    expect(inferVendorOrigin(name)).toEqual({ vendor, origin: ModelOrigin.DOMESTIC });
  });

  it('未知厂商默认按海外处理（保守：漏标国产只会少暴露，不会误放行海外模型）', () => {
    expect(inferVendorOrigin('some-internal-model-9')).toEqual({
      vendor: null,
      origin: ModelOrigin.OVERSEAS,
    });
    expect(inferVendorOrigin('')).toEqual({ vendor: null, origin: ModelOrigin.OVERSEAS });
  });

  it('大小写不敏感（上游命名混用大小写）', () => {
    expect(inferVendorOrigin('DeepSeek-V4-Pro').origin).toBe(ModelOrigin.DOMESTIC);
    expect(inferVendorOrigin('MINIMAX-M2.5').vendor).toBe('minimax');
  });
});
