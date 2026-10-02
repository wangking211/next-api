import {
  combineSignals,
  resolveTimeoutMs,
  splitNextSseBlock,
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

describe('splitNextSseBlock', () => {
  it('splits on LF boundary', () => {
    expect(splitNextSseBlock('data: a\n\ndata: b')).toEqual({
      block: 'data: a',
      rest: 'data: b',
    });
  });

  it('splits on CRLF boundary (\\r\\n\\r\\n contains no \\n\\n — old indexOf never matched)', () => {
    expect(splitNextSseBlock('data: a\r\n\r\ndata: b')).toEqual({
      block: 'data: a',
      rest: 'data: b',
    });
  });

  it('keeps an internal CRLF line break inside the block and strips the boundary only', () => {
    expect(splitNextSseBlock('data: a\r\ndata: b\r\n\r\nrest')).toEqual({
      block: 'data: a\r\ndata: b',
      rest: 'rest',
    });
  });

  it('returns null until a complete block arrives', () => {
    expect(splitNextSseBlock('data: a\n')).toBeNull();
    expect(splitNextSseBlock('data: a\r\n')).toBeNull();
    expect(splitNextSseBlock('')).toBeNull();
  });
});
