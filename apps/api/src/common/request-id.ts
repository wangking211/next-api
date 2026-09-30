import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/** 合法的入站 request id：1-64 位 [A-Za-z0-9._-]（客户端自定义 trace id 原样回显） */
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

type RequestWithId = Request & { requestId?: string };

/** 读取当前请求的 request id（中间件已注入；未经过中间件时返回空串） */
export function getRequestId(req: Request): string {
  return (req as RequestWithId).requestId ?? '';
}

/**
 * 请求关联：优先回显合法的入站 x-request-id，否则生成 UUID；
 * 无论哪种都写入响应头，客户端报错时可凭该 id 在日志里定位（错误日志带 [rid=...]）。
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header('x-request-id');
  const id = inbound && VALID_REQUEST_ID.test(inbound) ? inbound : randomUUID();
  (req as RequestWithId).requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
