import { EmailCodeService } from './email-code.service';
import { MailError, MailService } from '../mail/mail.service';
import { RedisService } from '../redis/redis.service';
import type { ConfigService } from '@nestjs/config';

/** 用一个内存哈希模拟 Redis，`down` 时所有命令都抛错（验证 Redis 故障必须 fail-closed） */
function makeRedis(opts: { down?: boolean } = {}) {
  const store: Record<string, string> = {};
  const boom = () => {
    if (opts.down) throw new Error('redis down');
  };
  const client = {
    get: jest.fn(async (k: string) => {
      boom();
      return store[k] ?? null;
    }),
    set: jest.fn(async (k: string, v: string, ...rest: (string | number)[]) => {
      boom();
      if (rest.includes('NX') && store[k] !== undefined) return null;
      store[k] = v;
      return 'OK';
    }),
    ttl: jest.fn(async (k: string) => {
      boom();
      return store[k] !== undefined ? 30 : -2;
    }),
    incr: jest.fn(async (k: string) => {
      boom();
      const n = (Number(store[k]) || 0) + 1;
      store[k] = String(n);
      return n;
    }),
    expire: jest.fn(async () => {
      boom();
      return true;
    }),
    del: jest.fn(async (...keys: string[]) => {
      boom();
      let n = 0;
      for (const k of keys) {
        if (store[k] !== undefined) {
          delete store[k];
          n++;
        }
      }
      return n;
    }),
  };
  return { client, store };
}

function makeMail(enabled = true) {
  return {
    enabled,
    sendVerificationCode: jest.fn(async (..._args: any[]): Promise<void> => undefined),
  };
}

function svc(opts: { down?: boolean; mailEnabled?: boolean } = {}) {
  const redis = makeRedis({ down: opts.down });
  const mail = makeMail(opts.mailEnabled ?? true);
  const config = { get: (_k: string, d?: string) => d } as unknown as ConfigService;
  const service = new EmailCodeService(
    mail as unknown as MailService,
    redis as unknown as RedisService,
    config,
  );
  return { service, ...redis, mail };
}

describe('EmailCodeService 启用与限流', () => {
  it('邮件通道未启用 → 503 AUTH_MAIL_NOT_CONFIGURED', async () => {
    const { service } = svc({ mailEnabled: false });
    expect(service.enabled).toBe(false);
    await expect(service.issue('a@b.com', 'register')).rejects.toMatchObject({
      status: 503,
      response: { code: 'AUTH_MAIL_NOT_CONFIGURED' },
    });
  });

  it('IP 维度超限 → 429 AUTH_IP_THROTTLED', async () => {
    const { service, store } = svc();
    store['mail:ip:9.9.9.9'] = '20';

    await expect(service.issue('a@b.com', 'register', 'zh-CN', '9.9.9.9')).rejects.toMatchObject({
      status: 429,
      response: { code: 'AUTH_IP_THROTTLED' },
    });
  });

  it('未超限时对 IP 计数并设窗口', async () => {
    const { service, store, client } = svc();
    await service.issue('a@b.com', 'register', 'zh-CN', '1.2.3.4');
    expect(client.incr).toHaveBeenCalledWith('mail:ip:1.2.3.4');
    expect(client.expire).toHaveBeenCalledWith('mail:ip:1.2.3.4', 300);
    expect(store['mail:ip:1.2.3.4']).toBe('1');
  });

  it('Redis 故障 → 503 AUTH_CODE_UNAVAILABLE（闸门 fail-closed，绝不放行）', async () => {
    const { service } = svc({ down: true });
    await expect(service.issue('a@b.com', 'register')).rejects.toMatchObject({
      status: 503,
      response: { code: 'AUTH_CODE_UNAVAILABLE' },
    });
    await expect(service.verify('a@b.com', 'register', '123456')).rejects.toMatchObject({
      status: 503,
      response: { code: 'AUTH_CODE_UNAVAILABLE' },
    });
  });
});

describe('EmailCodeService 签发', () => {
  it('成功落码 + 占冷却位 + 按 locale 投递', async () => {
    const { service, store, mail } = svc();

    const result = await service.issue('A@B.com', 'register', 'en-US', '1.2.3.4');

    expect(result).toEqual({ cooldownSeconds: 60 });
    expect(store['mail:code:register:a@b.com']).toMatch(/^\d{6}$/);
    expect(store['mail:cool:register:a@b.com']).toBe('1');
    expect(mail.sendVerificationCode).toHaveBeenCalledWith('a@b.com', {
      code: expect.stringMatching(/^\d{6}$/),
      purpose: 'register',
      locale: 'en',
      ttlMinutes: 10,
    });
  });

  it('冷却期内重发 → 429 且 details 带剩余秒数', async () => {
    const { service, store, mail } = svc();
    store['mail:cool:register:a@b.com'] = '1';

    await expect(service.issue('a@b.com', 'register')).rejects.toMatchObject({
      status: 429,
      response: { code: 'AUTH_CODE_RESEND_TOO_FREQUENT', details: { seconds: 30 } },
    });
    expect(mail.sendVerificationCode).not.toHaveBeenCalled();
  });

  it('deliver=false（查无此邮箱）：限流照走，但不落码、不占冷却、不发信', async () => {
    const { service, store, mail } = svc();

    const result = await service.issue('ghost@b.com', 'reset', 'zh-CN', '1.2.3.4', {
      deliver: false,
    });

    expect(result).toEqual({ cooldownSeconds: 60 });
    expect(store['mail:code:reset:ghost@b.com']).toBeUndefined();
    expect(store['mail:cool:reset:ghost@b.com']).toBeUndefined();
    expect(store['mail:ip:1.2.3.4']).toBe('1');
    expect(mail.sendVerificationCode).not.toHaveBeenCalled();
  });

  it('发信失败 → 回滚码与冷却位并抛 502 AUTH_MAIL_SEND_FAILED（可立即重试）', async () => {
    const { service, store, mail } = svc();
    mail.sendVerificationCode.mockRejectedValue(new MailError('send-failed', 'boom'));

    await expect(service.issue('a@b.com', 'register')).rejects.toMatchObject({
      status: 502,
      response: { code: 'AUTH_MAIL_SEND_FAILED' },
    });
    expect(store['mail:code:register:a@b.com']).toBeUndefined();
    expect(store['mail:cool:register:a@b.com']).toBeUndefined();
  });

  it('通道中途被判定未配置 → 503 而非 502（是环境问题，不是投递抖动）', async () => {
    const { service, mail } = svc();
    mail.sendVerificationCode.mockRejectedValue(new MailError('not-configured', 'no smtp'));

    await expect(service.issue('a@b.com', 'register')).rejects.toMatchObject({
      status: 503,
      response: { code: 'AUTH_MAIL_NOT_CONFIGURED' },
    });
  });
});

describe('EmailCodeService 校验', () => {
  it('码匹配 → 通过且不删（由调用方在业务成功后 clear）', async () => {
    const { service, store, client } = svc();
    store['mail:code:register:a@b.com'] = '123456';

    await expect(service.verify('a@b.com', 'register', '123456')).resolves.toBeUndefined();
    expect(store['mail:code:register:a@b.com']).toBe('123456');
    expect(client.del).not.toHaveBeenCalled();
  });

  it('码不匹配 → 400 AUTH_CODE_INVALID 并计一次失败', async () => {
    const { service, store } = svc();
    store['mail:code:register:a@b.com'] = '123456';

    await expect(service.verify('a@b.com', 'register', '654321')).rejects.toMatchObject({
      status: 400,
      response: { code: 'AUTH_CODE_INVALID' },
    });
    expect(store['mail:try:register:a@b.com']).toBe('1');
    expect(store['mail:code:register:a@b.com']).toBe('123456');
  });

  it('过期/从未签发与填错同码，不给「码还在」的提示', async () => {
    const { service } = svc();
    await expect(service.verify('a@b.com', 'register', '123456')).rejects.toMatchObject({
      status: 400,
      response: { code: 'AUTH_CODE_INVALID' },
    });
  });

  it('连续失败达上限 → 作废该码（5 次后连码带计数一起删）', async () => {
    const { service, store } = svc();
    store['mail:code:register:a@b.com'] = '123456';
    store['mail:try:register:a@b.com'] = '4';

    await expect(service.verify('a@b.com', 'register', '000000')).rejects.toMatchObject({
      status: 400,
      response: { code: 'AUTH_CODE_INVALID' },
    });
    expect(store['mail:code:register:a@b.com']).toBeUndefined();
    expect(store['mail:try:register:a@b.com']).toBeUndefined();
  });

  it('clear 把码与失败计数一起清掉', async () => {
    const { service, store } = svc();
    store['mail:code:reset:a@b.com'] = '123456';
    store['mail:try:reset:a@b.com'] = '2';

    await service.clear('A@B.com', 'reset');

    expect(store['mail:code:reset:a@b.com']).toBeUndefined();
    expect(store['mail:try:reset:a@b.com']).toBeUndefined();
  });
});

describe('EmailCodeService 配置读取', () => {
  it('mail-status 用的时长按分钟换算', () => {
    expect(svc().service.codeTtlMinutes).toBe(10);
    expect(svc().service.cooldownSeconds).toBe(60);
  });
});
