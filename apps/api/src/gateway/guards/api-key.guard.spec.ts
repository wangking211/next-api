import { ApiKeyGuard } from './api-key.guard';
import { ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { ApiKeyStatus, UserStatus } from '@prisma/client';

function makeGuard(opts: {
  pepper?: boolean;
  primary?: any;
  legacy?: any;
  updateThrows?: boolean;
  /** isModelAllowed 的返回值，默认全部放行 */
  modelAllowed?: boolean;
} = {}) {
  const crypto = {
    apiKeyHashingEnabled: opts.pepper ?? false,
    hashApiKey: (t: string) => `H:${t}`,
    legacyHashApiKey: (t: string) => `L:${t}`,
  };
  const prisma = {
    apiKey: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.keyHash.startsWith('H:')) return opts.primary ?? null;
        return opts.legacy ?? null;
      }),
      update: jest.fn(async () => {
        if (opts.updateThrows) throw new Error('unique conflict');
        return {};
      }),
    },
  };
  const rateLimiter = {
    check: jest.fn(async () => undefined),
    checkTpm: jest.fn(
      async (): Promise<number | null> => 123, // 预扣成功 → 返回桶号
    ),
    adjustTpm: jest.fn(async () => undefined),
  };
  const resolver = {
    isModelAllowed: jest.fn(async () => opts.modelAllowed ?? true),
  };
  const guard = new ApiKeyGuard(
    prisma as any,
    crypto as any,
    rateLimiter as any,
    resolver as any,
  );
  return { guard, prisma, rateLimiter, resolver };
}

function ctxWith(
  headers: Record<string, any>,
  extra: { body?: any; path?: string } = {},
) {
  const listeners: Record<string, Array<() => void>> = {};
  const res: any = {
    once: (ev: string, cb: () => void) => {
      (listeners[ev] ??= []).push(cb);
    },
    emit: (ev: string) => {
      for (const cb of listeners[ev] ?? []) cb();
    },
  };
  const req: any = { headers, body: extra.body ?? {}, path: extra.path ?? '/v1/chat/completions' };
  const ctx: any = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  };
  return { ctx, req, res };
}

const activeKey = (over = {}) => ({
  id: 'k1',
  status: ApiKeyStatus.ACTIVE,
  expiresAt: null,
  quotaLimit: null,
  quotaUsed: 0,
  costLimit: null,
  costUsed: 0,
  rpmLimit: null,
  tpmLimit: null,
  models: [] as string[],
  keyHash: 'H:tok',
  user: { id: 'u1', status: UserStatus.ACTIVE },
  ...over,
});

describe('ApiKeyGuard', () => {
  it('rejects missing token', async () => {
    const { guard } = makeGuard();
    const { ctx } = ctxWith({});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a valid key and attaches gateway context', async () => {
    const { guard, rateLimiter } = makeGuard({ primary: activeKey() });
    const { ctx, req } = ctxWith({ authorization: 'Bearer tok' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.gateway.user.id).toBe('u1');
    expect(rateLimiter.check).toHaveBeenCalledWith('k1', null, 'openai');
  });

  it('rejects inactive key', async () => {
    const { guard } = makeGuard({ primary: activeKey({ status: ApiKeyStatus.DISABLED }) });
    const { ctx } = ctxWith({ 'x-api-key': 'tok' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects banned account', async () => {
    const { guard } = makeGuard({
      primary: activeKey({ user: { id: 'u1', status: UserStatus.BANNED } }),
    });
    const { ctx } = ctxWith({ authorization: 'Bearer tok' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects exhausted token quota', async () => {
    const { guard } = makeGuard({
      primary: activeKey({ quotaLimit: 100, quotaUsed: 100 }),
    });
    const { ctx } = ctxWith({ authorization: 'Bearer tok' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('dual-reads a legacy hash and upgrades it to HMAC', async () => {
    const { guard, prisma } = makeGuard({ pepper: true, legacy: activeKey() });
    const { ctx, req } = ctxWith({ authorization: 'Bearer tok' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.gateway.apiKey.id).toBe('k1');
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { keyHash: 'H:tok' },
    });
  });

  it('still authenticates if the hash upgrade fails', async () => {
    const { guard } = makeGuard({ pepper: true, legacy: activeKey(), updateThrows: true });
    const { ctx } = ctxWith({ authorization: 'Bearer tok' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('passes anthropic format to rate limiter on /v1/messages', async () => {
    const { guard, rateLimiter } = makeGuard({ primary: activeKey() });
    const { ctx } = ctxWith(
      { authorization: 'Bearer tok' },
      { path: '/v1/messages' },
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(rateLimiter.check).toHaveBeenCalledWith('k1', null, 'anthropic');
  });

  describe('model whitelist', () => {
    it('rejects disallowed model with openai-format 403', async () => {
      const { guard, resolver } = makeGuard({
        primary: activeKey({ models: ['gpt-4o'] }),
        modelAllowed: false,
      });
      const { ctx } = ctxWith(
        { authorization: 'Bearer tok' },
        { body: { model: 'o3-mini' } },
      );
      const err = await guard.canActivate(ctx).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(403);
      expect(err.getResponse()).toEqual({
        error: {
          message: 'Model "o3-mini" is not allowed for this API key',
          type: 'permission_error',
          code: 'model_not_allowed',
        },
      });
      expect(resolver.isModelAllowed).toHaveBeenCalledWith('o3-mini', ['gpt-4o']);
    });

    it('rejects disallowed model with anthropic-format 403 on /v1/messages', async () => {
      const { guard } = makeGuard({
        primary: activeKey({ models: ['gpt-4o'] }),
        modelAllowed: false,
      });
      const { ctx } = ctxWith(
        { authorization: 'Bearer tok' },
        { path: '/v1/messages', body: { model: 'o3-mini', max_tokens: 16 } },
      );
      const err = await guard.canActivate(ctx).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(403);
      expect(err.getResponse()).toEqual({
        type: 'error',
        error: {
          type: 'permission_error',
          message: 'Model "o3-mini" is not allowed for this API key',
        },
      });
    });

    it('skips whitelist check when key has no model restriction', async () => {
      const { guard, resolver } = makeGuard({ primary: activeKey() });
      const { ctx } = ctxWith(
        { authorization: 'Bearer tok' },
        { body: { model: 'any-model' } },
      );
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(resolver.isModelAllowed).not.toHaveBeenCalled();
    });

    it('skips whitelist check when request carries no model', async () => {
      const { guard, resolver } = makeGuard({
        primary: activeKey({ models: ['gpt-4o'] }),
      });
      const { ctx } = ctxWith({ authorization: 'Bearer tok' }, { body: {} });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(resolver.isModelAllowed).not.toHaveBeenCalled();
    });
  });

  describe('TPM pre-deduct', () => {
    const messages = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello world' }] };

    it('pre-deducts when key has tpmLimit and registers settle listeners', async () => {
      const { guard, rateLimiter } = makeGuard({
        primary: activeKey({ tpmLimit: 1000 }),
      });
      const { ctx, req, res } = ctxWith(
        { authorization: 'Bearer tok' },
        { body: messages },
      );
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(rateLimiter.checkTpm).toHaveBeenCalledWith(
        'k1',
        1000,
        expect.any(Number),
        'openai',
      );
      expect(req.gateway.tpm).toMatchObject({ bucket: 123, estimate: expect.any(Number) });
      // finish 触发结算：actual 未回填 → 按 0 全额回滚
      res.emit('finish');
      await new Promise((r) => setImmediate(r));
      expect(rateLimiter.adjustTpm).toHaveBeenCalledWith(
        'k1',
        123,
        -req.gateway.tpm.estimate,
      );
    });

    it('settles by actual−estimate when controller backfilled usage', async () => {
      const { guard, rateLimiter } = makeGuard({
        primary: activeKey({ tpmLimit: 1000 }),
      });
      const { ctx, req, res } = ctxWith(
        { authorization: 'Bearer tok' },
        { body: messages },
      );
      await guard.canActivate(ctx);
      req.gateway.tpm.actual = req.gateway.tpm.estimate + 50;
      res.emit('finish');
      await new Promise((r) => setImmediate(r));
      expect(rateLimiter.adjustTpm).toHaveBeenCalledWith('k1', 123, 50);
    });

    it('settles only once even if finish and close both fire', async () => {
      const { guard, rateLimiter } = makeGuard({
        primary: activeKey({ tpmLimit: 1000 }),
      });
      const { ctx, res } = ctxWith(
        { authorization: 'Bearer tok' },
        { body: messages },
      );
      await guard.canActivate(ctx);
      res.emit('finish');
      res.emit('close');
      await new Promise((r) => setImmediate(r));
      expect(rateLimiter.adjustTpm).toHaveBeenCalledTimes(1);
    });

    it('does not pre-deduct when tpmLimit is not set', async () => {
      const { guard, rateLimiter } = makeGuard({ primary: activeKey() });
      const { ctx, req } = ctxWith(
        { authorization: 'Bearer tok' },
        { body: messages },
      );
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(rateLimiter.checkTpm).not.toHaveBeenCalled();
      expect(req.gateway.tpm).toBeUndefined();
    });

    it('does not register listeners when checkTpm was skipped (null bucket)', async () => {
      const { guard, rateLimiter } = makeGuard({
        primary: activeKey({ tpmLimit: 1000 }),
      });
      rateLimiter.checkTpm.mockResolvedValueOnce(null);
      const { ctx, req, res } = ctxWith(
        { authorization: 'Bearer tok' },
        { body: messages },
      );
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.gateway.tpm).toBeUndefined();
      res.emit('finish');
      await new Promise((r) => setImmediate(r));
      expect(rateLimiter.adjustTpm).not.toHaveBeenCalled();
    });

    it('propagates 429 from checkTpm with openai body', async () => {
      const { guard, rateLimiter } = makeGuard({
        primary: activeKey({ tpmLimit: 1000 }),
      });
      const { HttpException } = await import('@nestjs/common');
      rateLimiter.checkTpm.mockRejectedValueOnce(
        new HttpException(
          { error: { message: 'tpm exceeded', type: 'rate_limit_error', code: 'tokens_per_minute_exceeded' } },
          429,
        ),
      );
      const { ctx } = ctxWith(
        { authorization: 'Bearer tok' },
        { body: messages },
      );
      const err = await guard.canActivate(ctx).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(429);
    });
  });
});
