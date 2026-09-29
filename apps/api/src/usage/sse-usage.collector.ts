import { UsageInfo } from '../gateway/types';

/**
 * 消费 OpenAI 格式的 SSE 分片：提取 usage、累计输出文本（用于缺失 usage 时估算与内容记录）。
 * OpenAI 与 Anthropic/Gemini（已转换）流均产生 OpenAI 格式分片。
 */
export class SseUsageCollector {
  private buffer = '';
  private output = '';
  private upstreamUsage: UsageInfo | null = null;

  push(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.handleBlock(block);
    }
  }

  private handleBlock(block: string): void {
    for (const line of block.split('\n')) {
      const trimmed = line.replace(/\r$/, '');
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        if (json.usage) {
          this.upstreamUsage = {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            totalTokens:
              json.usage.total_tokens ??
              (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0),
            // 部分上游（如 DeepSeek / 本平台渠道）会在 usage 里带缓存 token，一并采集
            ...(json.usage.cache_read_tokens != null
              ? { cacheReadTokens: json.usage.cache_read_tokens }
              : {}),
            ...(json.usage.cache_write_tokens != null
              ? { cacheWriteTokens: json.usage.cache_write_tokens }
              : {}),
          };
        }
        const content = json.choices?.[0]?.delta?.content;
        if (typeof content === 'string') this.output += content;
      } catch {
        // 忽略无法解析的分片
      }
    }
  }

  /** 累计的输出文本 */
  get text(): string {
    return this.output;
  }

  result(fallbackPromptTokens: number): UsageInfo {
    if (this.upstreamUsage) return this.upstreamUsage;
    const completion = Math.ceil(this.output.length / 4);
    return {
      promptTokens: fallbackPromptTokens,
      completionTokens: completion,
      totalTokens: fallbackPromptTokens + completion,
    };
  }
}
