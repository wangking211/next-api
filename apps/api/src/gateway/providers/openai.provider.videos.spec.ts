import { Channel } from '@prisma/client';
import { OpenAiCompatibleProvider, detectErrorPayload } from './openai.provider';

describe('detectErrorPayload（200 + 错误体识别）', () => {
  it('正常载荷一律放行', () => {
    expect(detectErrorPayload({ choices: [] })).toBeNull();
    expect(detectErrorPayload({ data: [] })).toBeNull();
    expect(detectErrorPayload({ object: 'list', data: [] })).toBeNull();
    expect(
      detectErrorPayload({ id: 'task_x', object: 'video', status: 'queued' }),
    ).toBeNull();
    expect(detectErrorPayload({ output: [] })).toBeNull();
    expect(detectErrorPayload(null)).toBeNull();
    expect(detectErrorPayload('oops')).toBeNull();
  });

  it('New-API 风格 code=0 / success 视为成功', () => {
    expect(detectErrorPayload({ code: 0, msg: 'ok' })).toBeNull();
    expect(detectErrorPayload({ code: 'success', msg: 'ok' })).toBeNull();
    expect(detectErrorPayload({ code: 200, msg: 'ok' })).toBeNull();
  });

  it('数字错误码 → 对应状态（401 不可重试）', () => {
    expect(detectErrorPayload({ code: 401, msg: 'token 无效：sk-leak' })).toEqual({
      status: 401,
      retryable: false,
    });
    expect(detectErrorPayload({ code: 503, msg: 'busy' })).toEqual({
      status: 503,
      retryable: true,
    });
    expect(detectErrorPayload({ code: 429, msg: 'slow down' })).toEqual({
      status: 429,
      retryable: true,
    });
  });

  it('字符串错误码 / error 对象 → 502（可重试，触发故障转移）', () => {
    expect(detectErrorPayload({ code: 'fail_to_fetch_task', message: 'boom' })).toEqual({
      status: 502,
      retryable: true,
    });
    expect(detectErrorPayload({ error: { message: 'bad' } })).toEqual({
      status: 502,
      retryable: true,
    });
  });
});

describe('OpenAiCompatibleProvider 视频任务透传', () => {
  const channel = { baseUrl: 'https://up.example.com/v1' } as Channel;
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('POST /videos 到 {base}/videos 并原样透传请求体', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: 'task_abc',
          object: 'video',
          model: 'doubao-seedance-2-0-mini-260615',
          status: 'queued',
          progress: 0,
          created_at: 1790763889,
        }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider();
    const body = {
      model: 'doubao-seedance-2-0-mini-260615',
      prompt: 'a red balloon',
      seconds: 5,
      metadata: { resolution: '480p', ratio: '16:9' },
    };
    const result = await provider.videosCreate(channel, 'sk-up', {
      model: 'doubao-seedance-2-0-mini-260615',
      body,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://up.example.com/v1/videos');
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-up');
    expect(JSON.parse(init.body)).toEqual(body);
    expect(result.json.id).toBe('task_abc');
  });

  it('GET /videos/{id} 查状态', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ id: 'task_abc', status: 'in_progress', progress: 50 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider();
    const result = await provider.videoStatus(channel, 'sk-up', { taskId: 'task_abc' });

    expect(fetchMock.mock.calls[0][0]).toBe('https://up.example.com/v1/videos/task_abc');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(result.json.progress).toBe(50);
  });

  it('taskId 含非法字符时拒绝（防路径穿越）', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider();
    await expect(
      provider.videoStatus(channel, 'k', { taskId: '../../admin' }),
    ).rejects.toMatchObject({ status: 400, retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /videos 返回 200 + 错误体时抛 UpstreamError（不落账、可故障转移）', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          code: 'fail_to_fetch_task',
          message: 'InvalidParameter: duration not valid',
          data: null,
        }),
    }) as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider();
    await expect(
      provider.videosCreate(channel, 'k', { model: 'm', body: { model: 'm', prompt: 'x' } }),
    ).rejects.toMatchObject({
      status: 502,
      retryable: true,
      message: 'Upstream returned an error payload with HTTP 200',
    });
  });

  it('内容接口透传二进制流与 content-type', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'video/mp4',
        'content-length': '3',
      }),
      body: stream,
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider();
    const result = await provider.videoContent(channel, 'sk-up', { taskId: 'task_abc' });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://up.example.com/v1/videos/task_abc/content',
    );
    expect(result.contentType).toBe('video/mp4');
    expect(result.contentLength).toBe('3');
    const reader = result.stream.getReader();
    const { value } = await reader.read();
    expect(Array.from(value ?? [])).toEqual([1, 2, 3]);
  });
});
