import { Injectable } from '@nestjs/common';
import { Provider } from '../types';
import { OpenAiCompatibleProvider } from './openai.provider';
import { AnthropicProvider } from './anthropic.provider';
import { GeminiProvider } from './gemini.provider';

@Injectable()
export class ProviderRegistry {
  private readonly providers: Provider[] = [
    new AnthropicProvider(),
    new GeminiProvider(),
    new OpenAiCompatibleProvider(),
  ];
  private readonly byName = new Map<string, Provider>();

  constructor() {
    for (const p of this.providers) {
      this.byName.set(p.name.toLowerCase(), p);
      for (const a of p.aliases ?? []) this.byName.set(a.toLowerCase(), p);
    }
  }

  resolve(provider: string): Provider {
    // 未知服务商默认走 OpenAI 兼容协议
    return this.byName.get(provider?.toLowerCase()) ?? this.byName.get('openai')!;
  }
}
