import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { RedisService } from '../redis/redis.service';
import { ConfigService } from '@nestjs/config';

/**
 * 登录/注册的来源 IP 维度限流（LOGIN_IP_LIMIT / LOGIN_IP_WINDOW）。
 * 账号维度的失败限流挡不住「换账号轮换撞库」，IP 维度负责兜底。
 */
function svc(opts: { ipCount?: string | null; redisDown?: boolean } = {}) {
  const get = jest.fn((key: string, def?: string) => {
    if (key === 'LOGIN_IP_LIMIT') return '30';
    if (key === 'LOGIN_IP_WINDOW') return '300';
    if (key === 'LOGIN_FAIL_LIMIT') return '10';
    if (key === 'LOGIN_FAIL_WINDOW') return '300';
    return def;
  });
  const redis = {
    client: {
      get: jest.fn(async (key: string) => {
        if (opts.redisDown) throw new Error('redis down');
        if (key.startsWith('login:ip:')) return opts.ipCount ?? '0';
        return '0';
      }),
      incr: jest.fn(async () => 1),
      expire: jest.fn(async () => true),
      del: jest.fn(async () => 0),
    },
  };
  const users = {
    findByEmailOrUsername: jest.fn(async () => null),
    findByEmail: jest.fn(async () => null),
    findByUsername: jest.fn(async () => null),
    create: jest.fn(),
  };
  const auth = new AuthService(
    users as unknown as UsersService,
    {} as JwtService,
    redis as unknown as RedisService,
    { get } as unknown as ConfigService,
  );
  return { auth, redis, users };
}

describe('AuthService 登录 IP 限流', () => {
  it('同一 IP 达到限额 → 429', async () => {
    const { auth } = svc({ ipCount: '30' });
    await expect(
      auth.login({ identifier: 'a', password: 'x' }, '1.2.3.4'),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('未超限 → 继续账号维度校验', async () => {
    const { auth, users } = svc({ ipCount: '5' });
    await auth
      .login({ identifier: 'nobody', password: 'x' }, '1.2.3.4')
      .catch(() => undefined);
    expect(users.findByEmailOrUsername).toHaveBeenCalled();
  });

  it('Redis 不可用时放行，不阻断登录', async () => {
    const { auth, users } = svc({ redisDown: true });
    await auth
      .login({ identifier: 'nobody', password: 'x' }, '1.2.3.4')
      .catch(() => undefined);
    expect(users.findByEmailOrUsername).toHaveBeenCalled();
  });

  it('未提供来源 IP 时跳过 IP 维度计数', async () => {
    const { auth, redis } = svc({ ipCount: '30' });
    await auth.login({ identifier: 'nobody', password: 'x' }).catch(() => undefined);
    expect(redis.client.get).not.toHaveBeenCalledWith(
      expect.stringContaining('login:ip:'),
    );
    // incr 只应出现在账号维度失败限流，IP 维度不应有计数
    expect(redis.client.incr).not.toHaveBeenCalledWith(
      expect.stringContaining('login:ip:'),
    );
  });

  it('每次尝试都计数（成功也算），首次计数时设置过期窗口', async () => {
    const { auth, redis } = svc({ ipCount: '0' });
    await auth
      .login({ identifier: 'nobody', password: 'x' }, '1.2.3.4')
      .catch(() => undefined);
    expect(redis.client.incr).toHaveBeenCalledWith('login:ip:1.2.3.4');
    expect(redis.client.expire).toHaveBeenCalledWith('login:ip:1.2.3.4', 300);
  });
});
