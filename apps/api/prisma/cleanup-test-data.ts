/**
 * 清理 e2e 测试产生的数据，保留演示种子数据。
 *   pnpm cleanup            # 实际删除（仅限本地开发库）
 *   pnpm cleanup --dry-run  # 仅预览
 *   pnpm cleanup --force    # 非本地库 / NODE_ENV=production 时强制执行（危险）
 *
 * 识别规则：
 *  - 用户邮箱以 @test.com / @t.com 结尾（级联删除其 Key/渠道/日志/用量/账单）
 *  - 模型名前缀：smoke-model- / p4model- / p7plat- / p7byok- / ops-
 *  - 平台渠道名：e2e 使用过的固定名（不含 demo-*）
 *  - 兑换码备注以 batch- 开头
 *  - 上述用户产生的审计日志
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PrismaClient, ChannelOwnerType } from '@prisma/client';

for (const p of [join(__dirname, '..', '.env'), join(process.cwd(), '.env')]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([\w.]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  break;
}

const prisma = new PrismaClient();
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

/**
 * 安全守卫：非本地数据库或生产环境一律拒绝删除，防止在服务器上连到生产库误删真实数据
 *（本脚本按邮箱/渠道名/前缀匹配删除，规则会命中真实用户与兑换码）。
 * --dry-run 只读预览始终放行；确认无误可加 --force 强制执行。
 */
function assertSafeEnv() {
  if (DRY || FORCE) return;
  let host = '';
  try {
    host = new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    // URL 缺失/不可解析 → 按不安全处理
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!localHosts.has(host) || process.env.NODE_ENV === 'production') {
    console.error(
      `[cleanup] 拒绝执行：DATABASE_URL 主机 "${host || '(不可解析)'}"，` +
        `NODE_ENV=${process.env.NODE_ENV ?? '(未设置)'}。\n` +
        '此脚本会删除用户/渠道/兑换码等真实数据，仅允许在本地开发库运行。\n' +
        '确认无误可加 --force 强制执行，或先用 --dry-run 预览。',
    );
    process.exit(1);
  }
}

const TEST_MODEL_PREFIXES = ['smoke-model-', 'p4model-', 'p7plat-', 'p7byok-', 'ops-'];
const TEST_CHANNEL_NAMES = [
  'good-openai',
  'bad-openai',
  'good-anthropic',
  'good-gemini',
  'good',
  'bad',
  'plat',
  'byok',
  'ops-bad',
  'ops-good',
  'my-openai',
];

async function main() {
  assertSafeEnv();
  const users = await prisma.user.findMany({
    where: {
      OR: [{ email: { endsWith: '@test.com' } }, { email: { endsWith: '@t.com' } }],
    },
    select: { id: true, email: true, username: true },
  });
  const userIds = users.map((u) => u.id);

  const models = await prisma.modelCatalog.findMany({
    where: { OR: TEST_MODEL_PREFIXES.map((p) => ({ name: { startsWith: p } })) },
    select: { id: true, name: true },
  });

  const channels = await prisma.channel.findMany({
    where: {
      ownerUserId: null,
      ownerType: ChannelOwnerType.PLATFORM,
      name: { in: TEST_CHANNEL_NAMES },
    },
    select: { id: true, name: true },
  });

  const codes = userIds.length
    ? await prisma.redeemCode.findMany({
        where: { OR: [{ note: { startsWith: 'batch-' } }, { usedById: { in: userIds } }] },
        select: { id: true },
      })
    : await prisma.redeemCode.findMany({
        where: { note: { startsWith: 'batch-' } },
        select: { id: true },
      });

  const auditCount = userIds.length
    ? await prisma.auditLog.count({ where: { actorId: { in: userIds } } })
    : 0;

  console.log('待清理：');
  console.log(`  测试用户     ${users.length}  ${users.slice(0, 5).map((u) => u.username).join(', ')}${users.length > 5 ? ' ...' : ''}`);
  console.log(`  测试模型     ${models.length}  ${models.slice(0, 5).map((m) => m.name).join(', ')}${models.length > 5 ? ' ...' : ''}`);
  console.log(`  平台测试渠道 ${channels.length}  ${channels.map((c) => c.name).join(', ')}`);
  console.log(`  测试兑换码   ${codes.length}`);
  console.log(`  关联审计日志 ${auditCount}`);

  if (DRY) {
    console.log('\n[dry-run] 未执行删除。');
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (codes.length) {
      await tx.redeemCode.deleteMany({ where: { id: { in: codes.map((c) => c.id) } } });
    }
    if (channels.length) {
      await tx.channel.deleteMany({ where: { id: { in: channels.map((c) => c.id) } } });
    }
    if (models.length) {
      await tx.modelCatalog.deleteMany({ where: { id: { in: models.map((m) => m.id) } } });
    }
    if (userIds.length) {
      await tx.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } }); // 级联清理关联数据
    }
  });

  console.log('\n清理完成。演示数据（admin / demo / demo-* / 标准模型目录）已保留。');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
