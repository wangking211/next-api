import { VideoTaskService } from './video-task.service';

const ref = { channelId: 'c1', model: 'seedance-1.0-pro', userId: 'u1' };

describe('VideoTaskService（视频任务 → 渠道进程内映射）', () => {
  let service: VideoTaskService;

  beforeEach(() => {
    service = new VideoTaskService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('remember → lookup 返回完整映射（含写入时间）', () => {
    service.remember('t1', ref);
    const hit = service.lookup('t1');
    expect(hit).toMatchObject(ref);
    expect(typeof hit?.at).toBe('number');
    expect(service.size()).toBe(1);
  });

  it('未记录的任务 → undefined', () => {
    expect(service.lookup('nope')).toBeUndefined();
  });

  it('空 taskId → 忽略不入表', () => {
    service.remember('', ref);
    expect(service.size()).toBe(0);
    expect(service.lookup('')).toBeUndefined();
  });

  it('TTL 内有效（含边界），越界 1ms 即失效并删除', () => {
    const t0 = 1_700_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    service.remember('t1', ref);

    now.mockReturnValue(t0 + 24 * 3600 * 1000); // 恰好等于 TTL：比较是 >，仍有效
    expect(service.lookup('t1')).toBeDefined();

    now.mockReturnValue(t0 + 24 * 3600 * 1000 + 1); // 越界 → 失效
    expect(service.lookup('t1')).toBeUndefined();
    expect(service.size()).toBe(0); // 过期项在 lookup 时被删除
  });

  it('容量到顶且条目全部过期 → prune 清掉过期项后写入', () => {
    const t0 = 1_700_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    for (let i = 0; i < 5000; i++) service.remember(`t${i}`, ref);
    expect(service.size()).toBe(5000);

    now.mockReturnValue(t0 + 25 * 60 * 60 * 1000); // 全部越过 24h TTL
    service.remember('fresh', ref);
    expect(service.size()).toBe(1);
    expect(service.lookup('t0')).toBeUndefined();
    expect(service.lookup('fresh')).toBeDefined();
  });

  it('容量到顶且条目全部新鲜 → 整体重建只留最新写入', () => {
    for (let i = 0; i < 5000; i++) service.remember(`t${i}`, ref);
    service.remember('fresh', ref);
    expect(service.size()).toBe(1);
    expect(service.lookup('t4999')).toBeUndefined();
    expect(service.lookup('fresh')).toBeDefined();
  });

  describe('classify（状态/内容查询的属主准入）', () => {
    it('无映射 → missing（允许走探测兜底）', () => {
      expect(service.classify('nope', 'u1')).toEqual({ state: 'missing' });
    });

    it('属主一致 → owned 并带出映射', () => {
      service.remember('t1', ref);
      const r = service.classify('t1', 'u1');
      expect(r.state).toBe('owned');
      if (r.state === 'owned') expect(r.ref).toMatchObject(ref);
    });

    it('属主不符 → foreign（调用方按未知任务处理，禁止探测兜底）', () => {
      service.remember('t1', ref);
      expect(service.classify('t1', 'u2')).toEqual({ state: 'foreign' });
    });

    it('映射过期 → missing（foreign 不会因 TTL 残留）', () => {
      const t0 = 1_700_000_000_000;
      const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
      service.remember('t1', ref);
      now.mockReturnValue(t0 + 24 * 3600 * 1000 + 1);
      expect(service.classify('t1', 'u2')).toEqual({ state: 'missing' });
    });
  });
});
