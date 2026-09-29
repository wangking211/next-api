import { of } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor';

function makeContext(method: string, url: string) {
  const req: any = {
    method,
    originalUrl: url,
    url,
    headers: {},
    params: {},
    user: { id: 'u1', username: 'admin', role: 'ADMIN' },
  };
  const res = { statusCode: 200 };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as any;
}

function makeInterceptor() {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const interceptor = new AuditInterceptor(audit as any);
  const next = { handle: () => of({ ok: true }) };
  return { audit, interceptor, next };
}

describe('AuditInterceptor', () => {
  it('records mutating console API calls', async () => {
    const { audit, interceptor, next } = makeInterceptor();
    await firstValueFrom(interceptor.intercept(makeContext('POST', '/api/channels'), next));
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toEqual(
      expect.objectContaining({ method: 'POST', action: 'POST channels' }),
    );
  });

  it('skips gateway /v1 traffic (no audit noise)', async () => {
    const { audit, interceptor, next } = makeInterceptor();
    await firstValueFrom(
      interceptor.intercept(makeContext('POST', '/v1/chat/completions'), next),
    );
    await firstValueFrom(interceptor.intercept(makeContext('POST', '/v1/messages'), next));
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips non-mutating requests', async () => {
    const { audit, interceptor, next } = makeInterceptor();
    await firstValueFrom(interceptor.intercept(makeContext('GET', '/api/channels'), next));
    expect(audit.record).not.toHaveBeenCalled();
  });
});
