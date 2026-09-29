import { buildAnthropicBody, toOpenAiResponse, AnthropicProvider } from './anthropic.provider';
import { ChatRequest } from '../types';

describe('Anthropic conversion', () => {
  it('builds anthropic body from openai request', () => {
    const req: ChatRequest = {
      model: 'claude-3-5-sonnet',
      body: {
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
        temperature: 0.5,
        stop: ['END'],
      },
    };
    const out = buildAnthropicBody(req);
    expect(out.model).toBe('claude-3-5-sonnet');
    expect(out.max_tokens).toBe(1024);
    expect(out.system).toBe('be concise');
    expect(out.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(out.temperature).toBe(0.5);
    expect(out.stop_sequences).toEqual(['END']);
  });

  it('converts image_url data urls to anthropic image blocks', () => {
    const out = buildAnthropicBody({
      model: 'm',
      body: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      },
    });
    expect(out.messages[0].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('maps anthropic response to openai shape', () => {
    const res = toOpenAiResponse(
      {
        id: 'msg_1',
        model: 'claude-3-5-sonnet',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: 5 },
      },
      'fallback-model',
    );
    expect(res.object).toBe('chat.completion');
    expect(res.choices[0].message.content).toBe('Hello world');
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(res.usage).toEqual({
      prompt_tokens: 9,
      completion_tokens: 5,
      total_tokens: 14,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
  });

  it('maps max_tokens stop reason to length', () => {
    const res = toOpenAiResponse(
      { id: 'x', content: [], stop_reason: 'max_tokens', usage: {} },
      'm',
    );
    expect(res.choices[0].finish_reason).toBe('length');
  });

  it('计入缓存读写：prompt_tokens 含 cache（避免计费被二次扣减）', () => {
    const res = toOpenAiResponse(
      {
        id: 'msg_cache',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 7,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 100,
        },
      },
      'claude-3-5-sonnet',
    );
    // 100（非缓存输入）+ 900（缓存读）+ 100（缓存写）= 1100
    expect(res.usage).toEqual({
      prompt_tokens: 1100,
      completion_tokens: 7,
      total_tokens: 1107,
      cache_read_tokens: 900,
      cache_write_tokens: 100,
    });
  });

  it('流式翻译时采集真实用量（含缓存），不依赖估算', async () => {
    const provider = new AnthropicProvider();
    const enc = new TextEncoder();
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-3-5-sonnet","usage":{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":900,"cache_creation_input_tokens":100}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const e of events) controller.enqueue(enc.encode(e));
          controller.close();
        },
      }),
    } as any);

    const res = await provider.chatStream({ baseUrl: 'https://x' } as any, 'k', {
      model: 'claude-3-5-sonnet',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    const chunks: string[] = [];
    for await (const c of res.chunks) chunks.push(c);

    expect(chunks.join('')).toContain('data: [DONE]');
    expect(res.usageRef?.usage).toEqual({
      promptTokens: 1100,
      completionTokens: 7,
      totalTokens: 1107,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
    });
  });
});
