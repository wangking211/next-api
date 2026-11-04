import { SseUsageCollector } from './sse-usage.collector';

const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe('SseUsageCollector', () => {
  it('prefers upstream usage when present', () => {
    const c = new SseUsageCollector();
    c.push(chunk({ choices: [{ delta: { content: 'Hello world' } }] }));
    c.push(
      chunk({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
    c.push('data: [DONE]\n\n');
    expect(c.result(999)).toEqual({
      promptTokens: 5,
      completionTokens: 2,
      totalTokens: 7,
    });
  });

  it('captures cache tokens when the upstream reports them', () => {
    const c = new SseUsageCollector();
    c.push(
      chunk({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          cache_read_tokens: 90,
          cache_write_tokens: 10,
        },
      }),
    );
    c.push('data: [DONE]\n\n');
    expect(c.result(0)).toEqual({
      promptTokens: 100,
      completionTokens: 5,
      totalTokens: 105,
      cacheReadTokens: 90,
      cacheWriteTokens: 10,
    });
  });

  it('maps OpenAI cached_tokens and DeepSeek prompt_cache_hit_tokens', () => {
    const a = new SseUsageCollector();
    a.push(
      chunk({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }),
    );
    expect(a.result(0).cacheReadTokens).toBe(80);

    const b = new SseUsageCollector();
    b.push(
      chunk({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_cache_hit_tokens: 60,
          prompt_cache_miss_tokens: 40,
        },
      }),
    );
    expect(b.result(0).cacheReadTokens).toBe(60);
  });

  it('captures the upstream request id from the first chunk', () => {
    const c = new SseUsageCollector();
    expect(c.upstreamRequestId).toBeNull();
    c.push(chunk({ id: 'chatcmpl-up-1', choices: [{ delta: { content: 'x' } }] }));
    c.push(chunk({ id: 'chatcmpl-up-1', choices: [{ delta: {} }] }));
    expect(c.upstreamRequestId).toBe('chatcmpl-up-1');
  });

  it('falls back to estimation when usage missing', () => {
    const c = new SseUsageCollector();
    c.push(chunk({ choices: [{ delta: { content: '12345678' } }] }));
    c.push(chunk({ choices: [{ delta: { content: '1234' } }] }));
    c.push('data: [DONE]\n\n');
    const usage = c.result(3);
    expect(usage.promptTokens).toBe(3);
    expect(usage.completionTokens).toBe(3);
    expect(usage.totalTokens).toBe(6);
  });

  it('handles chunks split across SSE boundaries', () => {
    const c = new SseUsageCollector();
    const full = chunk({ choices: [{ delta: { content: 'Hello' } }] });
    c.push(full.slice(0, 10));
    c.push(full.slice(10));
    expect(c.result(0).completionTokens).toBe(2);
  });

  it('accumulates output text across chunks', () => {
    const c = new SseUsageCollector();
    c.push(chunk({ choices: [{ delta: { content: 'Hello' } }] }));
    c.push(chunk({ choices: [{ delta: { content: ' world' } }] }));
    c.push('data: [DONE]\n\n');
    expect(c.text).toBe('Hello world');
  });

  it('ignores malformed lines', () => {
    const c = new SseUsageCollector();
    c.push('data: {not json}\n\n');
    c.push('data: [DONE]\n\n');
    expect(c.result(1)).toEqual({ promptTokens: 1, completionTokens: 0, totalTokens: 1 });
  });

  it('parses CRLF-separated blocks identically to LF', () => {
    // 回归：'\r\n\r\n' 不含子串 '\n\n' → 旧 indexOf('\n\n') 永不切块，
    // usage 与输出文本全部丢失（计费/内容落盘归零）
    const crlf = (obj: unknown) => `data: ${JSON.stringify(obj)}\r\n\r\n`;
    const c = new SseUsageCollector();
    c.push(crlf({ choices: [{ delta: { content: 'Hello' } }] }));
    c.push(crlf({ choices: [{ delta: { content: ' world' } }] }));
    c.push(
      crlf({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
    c.push('data: [DONE]\r\n\r\n');
    expect(c.text).toBe('Hello world');
    expect(c.result(999)).toEqual({
      promptTokens: 5,
      completionTokens: 2,
      totalTokens: 7,
    });
  });
});
