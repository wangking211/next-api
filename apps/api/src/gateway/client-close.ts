/**
 * 追踪客户端是否提前断开连接（D1 clientClosed 缺陷的最小提取）。
 *
 * Node 语义（实测 v24，Node 18/20 同）：ServerResponse 的 'close' 在响应
 * **正常完成**时也会触发（此时 writableFinished=true，keep-alive 下同样），
 * 只有 writableFinished=false 才代表连接被提前销毁（客户端中途断开）。
 * 因此按 writableFinished 过滤，保证 isClosed()=true 仅意味着「提前断开」，
 * 正常完成的请求不会被误判为客户端断开（499）。
 *
 * 监听挂在 per-request 的 res 上，随响应对象一起被回收，无监听器泄漏；
 * Node 保证 'close' 至多触发一次，onPrematureClose 不会重复执行。
 *
 * @param res 响应对象（结构化类型：Express Response 满足此形状）
 * @param onPrematureClose 客户端提前断开时的回调（如中止上游请求）
 * @returns isClosed() 每次调用读取实时状态——流式路径在 await 之后必须
 *          重新调用，不能复用循环前的快照（旧 pipeStream 缺陷）。
 */
export function trackClientClose(
  res: {
    writableFinished: boolean;
    on(event: 'close', listener: () => void): unknown;
  },
  onPrematureClose?: () => void,
): { isClosed: () => boolean } {
  let closed = false;
  res.on('close', () => {
    if (closed || res.writableFinished) return; // 幂等 + 正常完成 ≠ 客户端断开
    closed = true;
    onPrematureClose?.();
  });
  return { isClosed: () => closed };
}
