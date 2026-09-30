import { ArgumentsHost, HttpException, UnauthorizedException } from '@nestjs/common';
import { GatewayErrorFilter, openaiTypeFor } from './gateway-error.filter';

function makeHost(path: string) {
  const res: any = {
    headersSent: false,
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const req = { method: 'POST', originalUrl: path, url: path };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  return { res, host };
}

describe('GatewayErrorFilter', () => {
  const filter = new GatewayErrorFilter();

  it('401 鉴权失败 → OpenAI 形状 authentication_error', () => {
    const { res, host } = makeHost('/v1/chat/completions');
    filter.catch(new UnauthorizedException(), host);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: { message: 'Unauthorized', type: 'authentication_error', code: null },
    });
  });

  it('/v1/messages → Anthropic 形状（Claude SDK 可解析）', () => {
    const { res, host } = makeHost('/v1/messages?beta=true');
    filter.catch(new UnauthorizedException('bad key'), host);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'bad key' },
    });
  });

  it('限流 429 → rate_limit_error，消息透传', () => {
    const { res, host } = makeHost('/v1/embeddings');
    filter.catch(new HttpException('slow down', 429), host);
    expect(res.statusCode).toBe(429);
    expect(res.body.error.type).toBe('rate_limit_error');
    expect(res.body.error.message).toBe('slow down');
  });

  it('未预期异常 → 500 server_error，且不泄露内部细节', () => {
    const { res, host } = makeHost('/v1/models');
    filter.catch(new TypeError('cannot read property x of undefined'), host);
    expect(res.statusCode).toBe(500);
    expect(res.body.error.type).toBe('server_error');
    expect(res.body.error.message).toBe(
      'The server had an error while processing your request.',
    );
    expect(res.body.error.message).not.toContain('cannot read');
  });

  it('ValidationPipe 的字段错误数组 → 逗号拼接', () => {
    const { res, host } = makeHost('/v1/chat/completions');
    filter.catch(
      new HttpException(
        { statusCode: 400, message: ['model 必填', 'prompt 必填'], error: 'Bad Request' },
        400,
      ),
      host,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
    expect(res.body.error.message).toBe('model 必填, prompt 必填');
  });

  it('响应已开始写入（流式）时不改写错误体', () => {
    const { res, host } = makeHost('/v1/chat/completions');
    res.headersSent = true;
    filter.catch(new Error('boom'), host);
    expect(res.body).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });

  it('状态码 → type 映射', () => {
    expect(openaiTypeFor(400)).toBe('invalid_request_error');
    expect(openaiTypeFor(403)).toBe('permission_error');
    expect(openaiTypeFor(404)).toBe('not_found_error');
    expect(openaiTypeFor(429)).toBe('rate_limit_error');
    expect(openaiTypeFor(503)).toBe('server_error');
  });
});
