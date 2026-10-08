import { OpenAiCompatibleProvider } from './openai.provider';
import { ChatRequest } from '../types';

describe('OpenAiCompatibleProvider', () => {
  const channel = { baseUrl: 'https://up.example/v1' } as any;

  afterEach(() => jest.restoreAllMocks());

  function jsonResponse(json: any, status = 200) {
    const text = JSON.stringify(json);
    const r: any = {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      // chatStream 的 stream_options 容错会先 clone() 再读错误体（与真实 Response 一致）
      clone: () => r,
    };
    return r;
  }

  /** 200 SSE 流式响应（mock，body 可被 pipeRaw 消费） */
  function streamResponse() {
    const enc = new TextEncoder();
    return {
      ok: true,
      status: 200,
      headers: {
        get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null),
      },
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      }),
    } as any;
  }

  it('posts chat bodies to /chat/completions with bearer auth', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse({
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );
    const provider = new OpenAiCompatibleProvider();
    const req: ChatRequest = { model: 'm', body: { messages: [] } };
    const res = await provider.chatNonStream(channel, 'sk-test', req);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, any];
    expect(url).toBe('https://up.example/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body)).toEqual({ messages: [] });
    expect(res.status).toBe(200);
    expect(res.usage).toEqual({
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
      cacheReadTokens: 0,
    });
  });

  it('posts embeddings bodies to /embeddings and maps usage (completion = 0)', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        jsonResponse({ object: 'list', data: [], usage: { prompt_tokens: 7, total_tokens: 7 } }),
      );
    const provider = new OpenAiCompatibleProvider();
    const req: ChatRequest = { model: 'text-embedding-3-small', body: { input: 'hi' } };
    const res = await provider.embeddingsNonStream!(channel, 'sk-test', req);

    const [url, init] = fetchSpy.mock.calls[0] as [string, any];
    expect(url).toBe('https://up.example/v1/embeddings');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body)).toEqual({ input: 'hi' });
    expect(res.usage).toEqual({
      promptTokens: 7,
      completionTokens: 0,
      totalTokens: 7,
      cacheReadTokens: 0,
    });
  });

  it('returns undefined usage when upstream omits it (caller falls back to estimate)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ object: 'list', data: [] }));
    const provider = new OpenAiCompatibleProvider();
    const res = await provider.embeddingsNonStream!(channel, 'k', {
      model: 'm',
      body: { input: 'x' },
    });
    expect(res.usage).toBeUndefined();
    expect(res.json.object).toBe('list');
  });

  it('throws retryable errors on 5xx/429 and non-retryable on 400', async () => {
    const provider = new OpenAiCompatibleProvider();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse({ error: { message: 'boom' } }, 500));
    await expect(
      provider.embeddingsNonStream!(channel, 'k', { model: 'm', body: { input: 'x' } }),
    ).rejects.toMatchObject({ status: 500, retryable: true });

    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ error: { message: 'x' } }, 429));
    await expect(
      provider.embeddingsNonStream!(channel, 'k', { model: 'm', body: { input: 'x' } }),
    ).rejects.toMatchObject({ status: 429, retryable: true });

    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse({ error: { message: 'bad input' } }, 400));
    await expect(
      provider.chatNonStream(channel, 'k', { model: 'm', body: {} }),
    ).rejects.toMatchObject({ status: 400, retryable: false });
  });

  it('maps fetch failures to retryable 502 connection errors', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const provider = new OpenAiCompatibleProvider();
    await expect(
      provider.chatNonStream(channel, 'k', { model: 'm', body: {} }),
    ).rejects.toMatchObject({ status: 502, retryable: true });
    await expect(
      provider.embeddingsNonStream!(channel, 'k', { model: 'm', body: { input: 'x' } }),
    ).rejects.toMatchObject({ status: 502, retryable: true });
  });

  describe('chatStream（流式 include_usage 真实用量）', () => {
    it('默认注入 stream: true + stream_options.include_usage', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(streamResponse());
      const provider = new OpenAiCompatibleProvider();
      const res = await provider.chatStream(channel, 'k', {
        model: 'm',
        body: { messages: [] },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, any];
      expect(JSON.parse(init.body)).toEqual({
        messages: [],
        stream: true,
        stream_options: { include_usage: true },
      });
      expect(res.status).toBe(200);
    });

    it('客户端显式指定 stream_options → 不覆盖', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(streamResponse());
      const provider = new OpenAiCompatibleProvider();
      await provider.chatStream(channel, 'k', {
        model: 'm',
        body: { messages: [], stream_options: { include_usage: false } },
      });
      const [, init] = fetchSpy.mock.calls[0] as [string, any];
      expect(JSON.parse(init.body).stream_options).toEqual({ include_usage: false });
    });

    it('上游不认 stream_options（400 报错提到该字段）→ 去掉重试一次', async () => {
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse({ error: { message: 'Unknown parameter: stream_options' } }, 400),
        )
        .mockResolvedValueOnce(streamResponse());
      const provider = new OpenAiCompatibleProvider();
      const res = await provider.chatStream(channel, 'k', {
        model: 'm',
        body: { messages: [] },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const bodies = fetchSpy.mock.calls.map(([, init]: any) => JSON.parse(init.body));
      expect(bodies[0].stream_options).toEqual({ include_usage: true });
      expect(bodies[1].stream_options).toBeUndefined();
      expect(res.status).toBe(200);
    });

    it('无关的 400 不重试（单次请求后直接抛错）', async () => {
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(jsonResponse({ error: { message: 'bad input' } }, 400));
      const provider = new OpenAiCompatibleProvider();
      await expect(
        provider.chatStream(channel, 'k', { model: 'm', body: { messages: [] } }),
      ).rejects.toMatchObject({ status: 400, retryable: false });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
