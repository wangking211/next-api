import { Role } from '@prisma/client';
import { AuthUser } from '../common/interfaces/auth.interface';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

function makeController() {
  const usage = { logs: jest.fn().mockResolvedValue({ items: [], total: 0 }) };
  const controller = new UsageController(usage as unknown as UsageService);
  return { controller, usage };
}

const member = { id: 'user1', role: Role.USER } as AuthUser;
const admin = { id: 'admin1', role: Role.ADMIN } as AuthUser;

/** 回归：logs 的 userId 过滤必须经 scope() 解析，不能被 query 覆盖（曾可跨租户读日志） */
describe('UsageController.logs 属主约束', () => {
  it('普通用户即使传了他人 userId 也只查自己', async () => {
    const { controller, usage } = makeController();

    await controller.logs(member, undefined, undefined, undefined, undefined, undefined, 'victim-user');

    const [scopeUserId, query] = usage.logs.mock.calls[0];
    expect(scopeUserId).toBe('user1');
    expect((query as { targetUserId?: string }).targetUserId).toBeUndefined();
  });

  it('普通用户传 scope=all 也只查自己', async () => {
    const { controller, usage } = makeController();

    await controller.logs(member, undefined, undefined, 'all', undefined, undefined, 'victim-user');

    expect(usage.logs.mock.calls[0][0]).toBe('user1');
  });

  it('管理员 scope=all 时可指定查看某个用户', async () => {
    const { controller, usage } = makeController();

    await controller.logs(admin, undefined, undefined, 'all', undefined, undefined, 'user2');

    expect(usage.logs.mock.calls[0][0]).toBe('user2');
  });

  it('管理员未指定 userId 时只看自己', async () => {
    const { controller, usage } = makeController();

    await controller.logs(admin);

    expect(usage.logs.mock.calls[0][0]).toBe('admin1');
  });
});
