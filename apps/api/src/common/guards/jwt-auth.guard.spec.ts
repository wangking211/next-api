import { JwtAuthGuard } from './jwt-auth.guard';
import { UnauthorizedException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';

function makeGuard(user: any) {
  const jwt = {
    verifyAsync: jest.fn(async (): Promise<any> => ({ sub: 'u1', role: 'USER' })),
  };
  const prisma = { user: { findUnique: jest.fn(async () => user) } };
  const guard = new JwtAuthGuard(jwt as any, prisma as any);
  return { guard, jwt, prisma };
}

function ctxWith(headers: Record<string, any>) {
  const req: any = { headers };
  const ctx: any = { switchToHttp: () => ({ getRequest: () => req }) };
  return { ctx, req };
}

describe('JwtAuthGuard', () => {
  it('rejects missing bearer token', async () => {
    const { guard } = makeGuard(null);
    const { ctx } = ctxWith({});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects invalid token', async () => {
    const { guard, jwt } = makeGuard(null);
    jwt.verifyAsync.mockRejectedValueOnce(new Error('bad token'));
    const { ctx } = ctxWith({ authorization: 'Bearer x' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a deleted user even with a valid token', async () => {
    const { guard } = makeGuard(null);
    const { ctx } = ctxWith({ authorization: 'Bearer x' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a banned user', async () => {
    const { guard } = makeGuard({ id: 'u1', status: UserStatus.BANNED, role: 'USER' });
    const { ctx } = ctxWith({ authorization: 'Bearer x' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('uses the role from the database, not the token', async () => {
    const { guard } = makeGuard({
      id: 'u1',
      email: 'a@b.c',
      username: 'a',
      role: 'ADMIN',
      status: UserStatus.ACTIVE,
    });
    const { ctx, req } = ctxWith({ authorization: 'Bearer x' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user.role).toBe('ADMIN');
  });

  it('rejects a token issued before tokenVersion was bumped（退出全部设备）', async () => {
    const { guard } = makeGuard({
      id: 'u1',
      email: 'a@b.c',
      username: 'a',
      role: 'USER',
      status: UserStatus.ACTIVE,
      tokenVersion: 1,
    });
    const { ctx } = ctxWith({ authorization: 'Bearer x' }); // payload 无 tv（=0）
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a token whose tv matches the current tokenVersion', async () => {
    const { guard, jwt } = makeGuard({
      id: 'u1',
      email: 'a@b.c',
      username: 'a',
      role: 'USER',
      status: UserStatus.ACTIVE,
      tokenVersion: 2,
    });
    jwt.verifyAsync.mockResolvedValueOnce({ sub: 'u1', role: 'USER', tv: 2 });
    const { ctx } = ctxWith({ authorization: 'Bearer x' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
