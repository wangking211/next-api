import { BootstrapService, assertStrongBootstrapPassword } from './bootstrap.service';

function makeService(opts: { nodeEnv?: string; password?: string; existing?: any }) {
  const values: Record<string, string | undefined> = {
    NODE_ENV: opts.nodeEnv ?? 'production',
    BOOTSTRAP_ADMIN_EMAIL: 'admin@aigw.local',
    BOOTSTRAP_ADMIN_USERNAME: 'admin',
    BOOTSTRAP_ADMIN_PASSWORD: opts.password ?? 'admin123456',
  };
  const config = { get: (k: string) => values[k] };
  const users = {
    findByEmail: jest.fn().mockResolvedValue(opts.existing ?? null),
    create: jest.fn().mockResolvedValue({}),
  };
  const service = new BootstrapService(config as any, users as any);
  return { service, users };
}

describe('assertStrongBootstrapPassword', () => {
  it('rejects the historical default password', () => {
    expect(() => assertStrongBootstrapPassword('admin123456')).toThrow(
      /BOOTSTRAP_ADMIN_PASSWORD 不安全/,
    );
  });

  it('rejects short and low-entropy passwords', () => {
    expect(() => assertStrongBootstrapPassword('short')).toThrow(/长度/);
    expect(() => assertStrongBootstrapPassword('a'.repeat(15))).toThrow(/熵/);
  });

  it('accepts a strong password', () => {
    expect(() => assertStrongBootstrapPassword('N7!vR2#qL9@xT')).not.toThrow();
  });
});

describe('BootstrapService.ensureAdmin', () => {
  it('fails startup on a weak bootstrap password in production', async () => {
    const { service, users } = makeService({ password: 'admin123456' });
    await expect(service.ensureAdmin()).rejects.toThrow(/BOOTSTRAP_ADMIN_PASSWORD 不安全/);
    expect(users.findByEmail).not.toHaveBeenCalled();
    expect(users.create).not.toHaveBeenCalled();
  });

  it('does not enforce the password policy outside production', async () => {
    const { service, users } = makeService({ nodeEnv: 'development', password: 'admin123456' });
    await service.ensureAdmin();
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'admin' }),
    );
  });

  it('creates nothing when the admin already exists', async () => {
    const { service, users } = makeService({
      password: 'N7!vR2#qL9@xT',
      existing: { id: 'u1', role: 'ADMIN' },
    });
    await service.ensureAdmin();
    expect(users.create).not.toHaveBeenCalled();
  });

  it('skips entirely when bootstrap env vars are absent', async () => {
    const config = { get: (k: string) => (k === 'NODE_ENV' ? 'production' : undefined) };
    const users = { findByEmail: jest.fn(), create: jest.fn() };
    const service = new BootstrapService(config as any, users as any);
    await service.ensureAdmin();
    expect(users.findByEmail).not.toHaveBeenCalled();
  });
});
