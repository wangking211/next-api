import { UsageInfo } from '../gateway/types';
import { splitNextSseBlock } from '../gateway/providers/stream.util';

/**
 * 消费 OpenAI 格式的 SSE 分片：提取 usage、累计输出文本（用于缺失 usage 时估算与内容记录）。
 * OpenAI 与 Anthropic/Gemini（已转换）流均产生 OpenAI 格式分片。
 */
export class SseUsageCollector {
  private buffer = '';
  private output = '';
  private upstreamUsage: UsageInfo | null = null;
  private requestId: string | null = null;

  push(chunk: string): void {
    this.buffer += chunk;
    // 分块复用 canonical 的 splitNextSseBlock（兼容 CRLF）；indexOf('\n\n') 漏掉 \r\n\r\n
    let next = splitNextSseBlock(this.buffer);
    while (next) {
      this.handleBlock(next.block);
      this.buffer = next.rest;
      next = splitNextSseBlock(this.buffer);
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
        // 上游请求 id（分片通常每帧都带，取第一个非空值）
        if (!this.requestId && typeof json.id === 'string' && json.id) this.requestId = json.id;
        if (json.usage) {
          const u = json.usage;
          const cacheRead =
            u.cache_read_tokens ??
            u.prompt_tokens_details?.cached_tokens ??
            u.prompt_cache_hit_tokens;
          const cacheWrite = u.cache_write_tokens;
          this.upstreamUsage = {
            promptTokens: u.prompt_tokens ?? 0,
            completionTokens: u.completion_tokens ?? 0,
            totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
            // 部分上游（DeepSeek / 本平台渠道）会在 usage 里带缓存 token，一并采集
            ...(cacheRead != null ? { cacheReadTokens: cacheRead } : {}),
            ...(cacheWrite != null ? { cacheWriteTokens: cacheWrite } : {}),
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

  /** 上游请求 id（未采集到为 null） */
  get upstreamRequestId(): string | null {
    return this.requestId;
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
