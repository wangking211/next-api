import { EventEmitter } from 'node:events';
import { trackClientClose } from './client-close';

/**
 * D1 clientClosed 缺陷回归：
 * - 断言 isClosed()=true 仅代表「客户端提前断开」（响应正常完成的 close 不置位）；
 * - 断言 isClosed() 每次读实时状态——pipeStream 循环前的一次性快照是旧缺陷，
 *   消费方必须在 await 之后重新读取（此用例锁定实时读语义）。
 */
describe('trackClientClose', () => {
  function fakeRes() {
    const ee = new EventEmitter();
    const res = {
      writableFinished: false,
      on(event: 'close', cb: () => void) {
        ee.on(event, cb);
        return res;
      },
    };
    return { res, close: () => ee.emit('close') };
  }

  it('initially reports not closed', () => {
    const { res } = fakeRes();
    expect(trackClientClose(res).isClosed()).toBe(false);
  });

  it('marks closed and fires onPremature on premature disconnect (writableFinished=false)', () => {
    const { res, close } = fakeRes();
    const onPremature = jest.fn();
    const tracker = trackClientClose(res, onPremature);
    res.writableFinished = false;
    close();
    expect(tracker.isClosed()).toBe(true);
    expect(onPremature).toHaveBeenCalledTimes(1);
  });

  it('does NOT mark closed on normal response completion (writableFinished=true)', () => {
    // Node：res 'close' 在响应正常完成时也会触发（keep-alive 同样），
    // 若不按 writableFinished 过滤，每个正常完成的请求都会被误判为客户端断开
    const { res, close } = fakeRes();
    const onPremature = jest.fn();
    const tracker = trackClientClose(res, onPremature);
    res.writableFinished = true;
    close();
    expect(tracker.isClosed()).toBe(false);
    expect(onPremature).not.toHaveBeenCalled();
  });

  it('isClosed() reads live state: a mid-stream disconnect is visible to later reads', () => {
    const { res, close } = fakeRes();
    const tracker = trackClientClose(res);
    const early = tracker.isClosed(); // 循环开始前读到的旧值（等价于 pipeStream 旧快照）
    res.writableFinished = false;
    close();
    expect(early).toBe(false); // 早期读数已过时——消费方不能复用快照
    expect(tracker.isClosed()).toBe(true); // 之后的读必须看到断开
  });

  it('invokes onPremature at most once', () => {
    const { res, close } = fakeRes();
    const onPremature = jest.fn();
    trackClientClose(res, onPremature);
    res.writableFinished = false;
    close();
    close();
    expect(onPremature).toHaveBeenCalledTimes(1);
  });
});
