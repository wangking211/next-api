import type { NextFunction, Request, Response } from 'express';
import { getRequestId, requestIdMiddleware } from './request-id';

function fakeRes(): Response {
  return { setHeader: jest.fn() } as unknown as Response;
}

function fakeReq(inbound?: string): Request {
  return {
    header: (name: string) => (name === 'x-request-id' ? inbound : undefined),
  } as unknown as Request;
}

describe('requestIdMiddleware', () => {
  it('合法入站 x-request-id 原样回显（便于客户端 trace）', () => {
    const res = fakeRes();
    const next = jest.fn() as unknown as NextFunction;
    const req = fakeReq('client-trace_1.2-3');
    requestIdMiddleware(req, res, next);
    expect(getRequestId(req)).toBe('client-trace_1.2-3');
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'client-trace_1.2-3');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('非法入站（超长/非法字符）→ 生成 UUID 覆盖', () => {
    for (const bad of ['x'.repeat(65), 'has space', '中文id', 'a/b', '']) {
      const res = fakeRes();
      const req = fakeReq(bad);
      requestIdMiddleware(req, res, jest.fn() as unknown as NextFunction);
      const id = getRequestId(req);
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(res.setHeader).toHaveBeenCalledWith('x-request-id', id);
    }
  });

  it('无入站头 → 生成 UUID', () => {
    const res = fakeRes();
    const req = fakeReq(undefined);
    requestIdMiddleware(req, res, jest.fn() as unknown as NextFunction);
    expect(getRequestId(req)).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.setHeader).toHaveBeenCalledTimes(1);
  });

  it('未经过中间件时 getRequestId 返回空串', () => {
    expect(getRequestId(fakeReq())).toBe('');
  });
});
