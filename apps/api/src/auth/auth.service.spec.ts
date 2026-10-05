import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { RedisService } from '../redis/redis.service';
import { EmailCodeService } from './email-code.service';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';

/**
 * 登录/注册的来源 IP 维度限流（LOGIN_IP_LIMIT / LOGIN_IP_WINDOW）。
 * 账号维度的失败限流挡不住「换账号轮换撞库」，IP 维度负责兜底。
 *
 * `mailEnabled` 模拟 SMTP 是否已配置：默认关闭（保持免验证码注册的历史口径），
 * 打开时注册链路会强制校验邮箱验证码。
 */
function svc(
  opts: { ipCount?: string | null; redisDown?: boolean; mailEnabled?: boolean } = {},
) {
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
    findByEmailOrUsername: jest.fn(async (_identifier?: string): Promise<any> => null),
    findByEmail: jest.fn(async (_email?: string): Promise<any> => null),
    findByUsername: jest.fn(async (_username?: string): Promise<any> => null),
    findByUsernameInsensitive: jest.fn(async (_username?: string): Promise<any> => null),
    create: jest.fn(async (data: any): Promise<any> => ({ id: 'u-new', ...data })),
    setPassword: jest.fn(async (..._args: any[]): Promise<any> => ({ id: 'u1' })),
  };
  const codes = {
    enabled: opts.mailEnabled ?? false,
    cooldownSeconds: 60,
    codeTtlMinutes: 10,
    verify: jest.fn(async (..._args: any[]): Promise<void> => undefined),
    clear: jest.fn(async (..._args: any[]): Promise<void> => undefined),
    issue: jest.fn(
      async (..._args: any[]): Promise<{ cooldownSeconds: number }> => ({ cooldownSeconds: 60 }),
    ),
  };
  const jwt = { signAsync: jest.fn(async () => 'signed-token') };
  const auth = new AuthService(
    users as unknown as UsersService,
    jwt as unknown as JwtService,
    redis as unknown as RedisService,
    codes as unknown as EmailCodeService,
    { get } as unknown as ConfigService,
  );
  return { auth, redis, users, codes, jwt };
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
    await auth.login({ identifier: 'nobody', password: 'x' }, '1.2.3.4').catch(() => undefined);
    expect(redis.client.incr).toHaveBeenCalledWith('login:ip:1.2.3.4');
    expect(redis.client.expire).toHaveBeenCalledWith('login:ip:1.2.3.4', 300);
  });
});

/**
 * 登录/注册失败带稳定错误码：控制台据此换本地化文案，
 * 避免中文界面直接显示后端的英文 message。
 */
describe('AuthService 登录/注册错误码', () => {
  it('账号或密码错误 → 401 + AUTH_INVALID_CREDENTIALS', async () => {
    const { auth } = svc({});
    await expect(auth.login({ identifier: 'nobody', password: 'x' })).rejects.toMatchObject({
      status: 401,
      response: { code: 'AUTH_INVALID_CREDENTIALS' },
    });
  });

  it('账号被封禁 → 401 + AUTH_ACCOUNT_BANNED（与密码错误可区分）', async () => {
    const { auth, users } = svc({});
    const passwordHash = await bcrypt.hash('correct-password', 4);
    users.findByEmailOrUsername.mockResolvedValue({ id: 'u1', status: 'BANNED', passwordHash });

    await expect(
      auth.login({ identifier: 'banned', password: 'correct-password' }),
    ).rejects.toMatchObject({ status: 401, response: { code: 'AUTH_ACCOUNT_BANNED' } });
  });

  it('注册命中用户名（大小写不敏感）→ 409 + AUTH_USERNAME_TAKEN', async () => {
    const { auth, users } = svc({});
    users.findByUsernameInsensitive.mockResolvedValue({ id: 'u2' });

    await expect(
      auth.register({ email: 'New@Example.com', username: 'Admin', password: 'abcd1234' }),
    ).rejects.toMatchObject({ status: 409, response: { code: 'AUTH_USERNAME_TAKEN' } });
    expect(users.findByUsernameInsensitive).toHaveBeenCalledWith('Admin');
  });
});

/**
 * 邮箱验证码：SMTP 未配置时注册保持免验证码（凭据未到位不卡线上），
 * 配置齐了就强制校验，验过码的账号落 emailVerified。
 */
describe('AuthService 注册验证码', () => {
  it('SMTP 未配置 → 不校验验证码、不写 emailVerified（与改造前行为一致）', async () => {
    const { auth, users, codes } = svc({});
    await auth.register({ email: 'a@b.com', username: 'u1', password: 'abcd1234' });

    expect(codes.verify).not.toHaveBeenCalled();
    expect(users.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ emailVerified: true }),
    );
  });

  it('SMTP 已配置但没带码 → 400 + AUTH_CODE_REQUIRED', async () => {
    const { auth } = svc({ mailEnabled: true });
    await expect(
      auth.register({ email: 'a@b.com', username: 'u1', password: 'abcd1234' }),
    ).rejects.toMatchObject({ status: 400, response: { code: 'AUTH_CODE_REQUIRED' } });
  });

  it('SMTP 已配置且带码 → 按小写邮箱校验，建号写 emailVerified=true 并消费码', async () => {
    const { auth, users, codes } = svc({ mailEnabled: true });
    await auth.register({
      email: '  A@B.com ',
      username: 'u1',
      password: 'abcd1234',
      emailCode: '123456',
    });

    expect(codes.verify).toHaveBeenCalledWith('a@b.com', 'register', '123456');
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.com', emailVerified: true }),
    );
    expect(codes.clear).toHaveBeenCalledWith('a@b.com', 'register');
  });

  it('验证码校验失败 → 原样抛出，不建号', async () => {
    const { auth, users, codes } = svc({ mailEnabled: true });
    codes.verify.mockRejectedValue({ status: 400, response: { code: 'AUTH_CODE_INVALID' } });

    await expect(
      auth.register({ email: 'a@b.com', username: 'u1', password: 'abcd1234', emailCode: '000000' }),
    ).rejects.toMatchObject({ status: 400, response: { code: 'AUTH_CODE_INVALID' } });
    expect(users.create).not.toHaveBeenCalled();
  });

  it('先查重后验码：邮箱已占用直接 409，不消耗验证码', async () => {
    const { auth, users, codes } = svc({ mailEnabled: true });
    users.findByEmail.mockResolvedValue({ id: 'u9' });

    await expect(
      auth.register({ email: 'a@b.com', username: 'u1', password: 'abcd1234', emailCode: '123456' }),
    ).rejects.toMatchObject({ status: 409, response: { code: 'AUTH_EMAIL_TAKEN' } });
    expect(codes.verify).not.toHaveBeenCalled();
  });
});

describe('AuthService 请求验证码', () => {
  it('注册用途 + 邮箱已存在 → 409，与注册接口同口径', async () => {
    const { auth, users, codes } = svc({ mailEnabled: true });
    users.findByEmail.mockResolvedValue({ id: 'u9' });

    await expect(auth.requestEmailCode('a@b.com', 'register')).rejects.toMatchObject({
      status: 409,
      response: { code: 'AUTH_EMAIL_TAKEN' },
    });
    expect(codes.issue).not.toHaveBeenCalled();
  });

  it('注册用途 + 邮箱可用 → 正常投递', async () => {
    const { auth, codes } = svc({ mailEnabled: true });
    await expect(auth.requestEmailCode('a@b.com', 'register', 'en', '1.2.3.4')).resolves.toEqual({
      cooldownSeconds: 60,
    });
    expect(codes.issue).toHaveBeenCalledWith('a@b.com', 'register', 'en', '1.2.3.4', {
      deliver: true,
    });
  });

  it('找回密码用途：邮箱已注册 → 投递；查无此邮箱 → 同样 200 但不投递也不占冷却', async () => {
    const { auth, users, codes } = svc({ mailEnabled: true });

    users.findByEmail.mockResolvedValue({ id: 'u1' });
    await auth.requestEmailCode('a@b.com', 'reset', 'zh-CN', '1.2.3.4');
    expect(codes.issue).toHaveBeenLastCalledWith('a@b.com', 'reset', 'zh-CN', '1.2.3.4', {
      deliver: true,
    });

    users.findByEmail.mockResolvedValue(null);
    await auth.requestEmailCode('ghost@b.com', 'reset', 'zh-CN', '1.2.3.4');
    expect(codes.issue).toHaveBeenLastCalledWith('ghost@b.com', 'reset', 'zh-CN', '1.2.3.4', {
      deliver: false,
    });
  });

  it('mailStatus 暴露开关与冷却参数供前端渲染', () => {
    const { auth } = svc({ mailEnabled: true });
    expect(auth.mailStatus()).toEqual({ enabled: true, cooldownSeconds: 60, ttlMinutes: 10 });
    expect(svc({}).auth.mailStatus().enabled).toBe(false);
  });
});

describe('AuthService 找回密码', () => {
  const creds = { email: 'A@B.com', code: '123456', password: 'newpass123' };

  it('验证码通过 → 改密码 + 强制下线旧会话 + 消费码', async () => {
    const { auth, users, codes } = svc({ mailEnabled: true });
    users.findByEmail.mockResolvedValue({ id: 'u1' });

    await expect(auth.resetPassword(creds.email, creds.code, creds.password)).resolves.toBe(
      undefined,
    );

    expect(codes.verify).toHaveBeenCalledWith('a@b.com', 'reset', '123456');
    expect(users.setPassword).toHaveBeenCalledWith('u1', expect.any(String), {
      emailVerified: true,
    });
    expect(codes.clear).toHaveBeenCalledWith('a@b.com', 'reset');
  });

  it('验证码不通过 → 不改密码', async () => {
    const { auth, users, codes } = svc({ mailEnabled: true });
    codes.verify.mockRejectedValue({ status: 400, response: { code: 'AUTH_CODE_INVALID' } });

    await expect(
      auth.resetPassword(creds.email, creds.code, creds.password),
    ).rejects.toMatchObject({ status: 400, response: { code: 'AUTH_CODE_INVALID' } });
    expect(users.setPassword).not.toHaveBeenCalled();
    expect(codes.clear).not.toHaveBeenCalled();
  });

  it('码有效但账号已注销 → 404 + USER_NOT_FOUND', async () => {
    const { auth, users } = svc({ mailEnabled: true });
    users.findByEmail.mockResolvedValue(null);

    await expect(
      auth.resetPassword(creds.email, creds.code, creds.password),
    ).rejects.toMatchObject({ status: 404, response: { code: 'USER_NOT_FOUND' } });
  });

  it('改密码后签发的新密码确实落库（bcrypt 轮数校验）', async () => {
    const { auth, users } = svc({ mailEnabled: true });
    users.findByEmail.mockResolvedValue({ id: 'u1' });

    await auth.resetPassword(creds.email, creds.code, creds.password);

    const [id, hash] = users.setPassword.mock.calls[0];
    expect(id).toBe('u1');
    await expect(bcrypt.compare(creds.password, hash)).resolves.toBe(true);
  });
});
