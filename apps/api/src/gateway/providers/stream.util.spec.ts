import {
  combineSignals,
  resolveTimeoutMs,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
} from './stream.util';

describe('resolveTimeoutMs', () => {
  it('defaults to 120s when timeoutMs is not specified', () => {
    expect(resolveTimeoutMs(undefined)).toBe(DEFAULT_UPSTREAM_TIMEOUT_MS);
    expect(resolveTimeoutMs()).toBe(120000);
  });

  it('keeps 0 as unlimited (streaming) and explicit values as-is', () => {
    expect(resolveTimeoutMs(0)).toBe(0);
    expect(resolveTimeoutMs(5000)).toBe(5000);
  });
});

describe('combineSignals', () => {
  it('streaming path (timeoutMs=0) passes the external signal through unchanged', () => {
    const ext = new AbortController().signal;
    expect(combineSignals(0, ext)).toBe(ext);
  });

  it('non-streaming path without timeoutMs combines a default timeout with the external signal', () => {
    // 回归：旧实现在外部信号存在时跳过总超时 → 上游挂死且阻塞故障转移
    const ext = new AbortController().signal;
    expect(combineSignals(undefined, ext)).not.toBe(ext);
  });

  it('explicit timeout still aborts the signal', async () => {
    const sig = combineSignals(20);
    expect(sig.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(sig.aborted).toBe(true);
    expect(sig.reason?.name).toBe('TimeoutError');
  });
});
