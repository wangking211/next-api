import { ApiKeyGuard } from './api-key.guard';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiKeyStatus, UserStatus } from '@prisma/client';

function makeGuard(opts: {
  pepper?: boolean;
  primary?: any;
  legacy?: any;
  updateThrows?: boolean;
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
  const rateLimiter = { check: jest.fn(async () => undefined) };
  const guard = new ApiKeyGuard(
    prisma as any,
    crypto as any,
    rateLimiter as any,
  );
  return { guard, prisma, rateLimiter };
}

function ctxWith(headers: Record<string, any>) {
  const req: any = { headers };
  const ctx: any = { switchToHttp: () => ({ getRequest: () => req }) };
  return { ctx, req };
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
    expect(rateLimiter.check).toHaveBeenCalledWith('k1', null);
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
});
