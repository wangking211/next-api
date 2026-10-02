import {
  videoCompatCreateResponse,
  videoCompatRequestBody,
  videoCompatStatusResponse,
} from './video-compat.util';

describe('videoCompatRequestBody（兼容格式 → OpenAI /videos）', () => {
  it('duration 映射为 seconds 并移除原字段', () => {
    expect(videoCompatRequestBody({ model: 'm', prompt: 'p', duration: 4 })).toEqual({
      model: 'm',
      prompt: 'p',
      seconds: 4,
    });
  });

  it('已给 seconds 时以 seconds 为准（不被 duration 覆盖）', () => {
    expect(videoCompatRequestBody({ seconds: 8, duration: 4 })).toEqual({ seconds: 8 });
  });

  it('透传其余字段（image / metadata / resolution…）', () => {
    expect(
      videoCompatRequestBody({
        model: 'm',
        prompt: 'p',
        duration: 4,
        image: 'https://example.com/in.png',
        metadata: { resolution: '720p' },
      }),
    ).toEqual({
      model: 'm',
      prompt: 'p',
      seconds: 4,
      image: 'https://example.com/in.png',
      metadata: { resolution: '720p' },
    });
  });

  it('无 duration 或空体时原样返回（不造字段）', () => {
    expect(videoCompatRequestBody({ model: 'm', prompt: 'p' })).toEqual({
      model: 'm',
      prompt: 'p',
    });
    expect(videoCompatRequestBody(undefined as unknown as Record<string, any>)).toEqual({});
  });
});

describe('videoCompatCreateResponse（建任务响应）', () => {
  it('{id, object, status} → {task_id, status}，丢弃 OpenAI 侧字段', () => {
    expect(
      videoCompatCreateResponse({
        id: 'task_abc',
        object: 'video',
        model: 'doubao-seedance-2-0-260128',
        status: 'queued',
        progress: 0,
        created_at: 1790763889,
      }),
    ).toEqual({ task_id: 'task_abc', status: 'queued' });
  });

  it('缺 status 回退 queued（建任务即排队）', () => {
    expect(videoCompatCreateResponse({ id: 'task_abc' })).toEqual({
      task_id: 'task_abc',
      status: 'queued',
    });
  });

  it('缺 id 时不编造 task_id（保持 status 供客户端识别）', () => {
    expect(videoCompatCreateResponse({ status: 'queued' })).toEqual({ status: 'queued' });
  });
});

describe('videoCompatStatusResponse（状态响应）', () => {
  const url = 'https://xiaopuyun.com/v1/videos/task_abc/content';

  it('completed → 给出可下载直链与格式', () => {
    expect(
      videoCompatStatusResponse(
        { id: 'task_abc', status: 'completed', progress: 100, seconds: '5' },
        url,
      ),
    ).toEqual({
      task_id: 'task_abc',
      status: 'completed',
      url,
      format: 'mp4',
      metadata: { duration: 5, progress: 100 },
    });
  });

  it('未完成不给 url/format（成片还不存在）', () => {
    const out = videoCompatStatusResponse(
      { id: 'task_abc', status: 'in_progress', progress: 50 },
      url,
    );
    expect(out).toEqual({
      task_id: 'task_abc',
      status: 'in_progress',
      metadata: { progress: 50 },
    });
    expect(out).not.toHaveProperty('url');
  });

  it('seconds 字符串转 metadata.duration 数值；非数值不写入', () => {
    expect(
      videoCompatStatusResponse({ id: 't', status: 'completed', seconds: '8' }, url).metadata,
    ).toEqual({ duration: 8 });
    expect(
      videoCompatStatusResponse({ id: 't', status: 'completed', seconds: 'n/a' }, url).metadata,
    ).toBeUndefined();
  });

  it('上游没给 status/progress 时也不崩', () => {
    expect(videoCompatStatusResponse({ id: 't' }, url)).toEqual({
      task_id: 't',
      status: 'unknown',
    });
    expect(videoCompatStatusResponse({}, url)).toEqual({ status: 'unknown' });
  });
});
