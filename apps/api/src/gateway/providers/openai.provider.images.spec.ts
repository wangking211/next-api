import { Channel } from '@prisma/client';
import { OpenAiCompatibleProvider } from './openai.provider';

describe('OpenAiCompatibleProvider.imagesGenerate', () => {
  const channel = { baseUrl: 'https://up.example.com/v1' } as Channel;
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('POST /images/generations 到 {base}/images/generations 并原样透传请求体', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          created: 1,
          data: [{ url: 'https://img/x.png' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider();
    const body = { model: 'gpt-image-2', prompt: 'a cat', n: 2, size: '1024x1024' };
    const result = await provider.imagesGenerate(channel, 'sk-up', {
      model: 'gpt-image-2',
      body,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://up.example.com/v1/images/generations');
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-up');
    expect(JSON.parse(init.body)).toEqual(body);
    expect(result.status).toBe(200);
    expect(result.json.data).toHaveLength(1);
    expect(result.usage?.totalTokens).toBe(30);
  });

  it('上游 5xx 抛可重试的 UpstreamError（供故障转移）', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: { message: 'busy' } }),
    }) as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider();
    await expect(
      provider.imagesGenerate(channel, 'k', { model: 'm', body: { model: 'm', prompt: 'x' } }),
    ).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it('非 JSON 错误体也能构造可读错误', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '<html>bad request</html>',
    }) as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider();
    await expect(
      provider.imagesGenerate(channel, 'k', { model: 'm', body: { model: 'm', prompt: 'x' } }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
