/**
 * 幂等种子脚本：可重复执行。
 *   pnpm seed   （等价于 pnpm --filter @ai-gateway/api prisma:seed）
 *
 * 内容：管理员、模型目录、平台渠道（指向本地 mock 上游）、演示用户+余额+平台 Key。
 * 通过环境变量可覆盖：SEED_ADMIN_EMAIL / SEED_DEMO_USER / SEED_DEMO_PASSWORD / DEMO_UPSTREAM_URL
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { PrismaClient, ChannelOwnerType, ChannelStatus, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { COMMON_MODELS } from '../src/models/common-models';

// ts-node 运行时不自动加载 .env，这里手动加载（不覆盖已有环境变量）
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

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL ?? process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@aigw.local').toLowerCase();
const ADMIN_USERNAME = process.env.BOOTSTRAP_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'admin123456';

const DEMO_EMAIL = (process.env.SEED_DEMO_USER ?? 'demo@aigw.local').toLowerCase();
const DEMO_USERNAME = 'demo';
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'demo123456';
const DEMO_TOPUP = 100;

const UPSTREAM = process.env.DEMO_UPSTREAM_URL ?? 'http://localhost:4001';

function encKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY 必须是 32 字节 hex（64 字符）');
  }
  return Buffer.from(hex, 'hex');
}

/** 与 CryptoService.encrypt 保持一致的 AES-256-GCM 格式 */
function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const prefix = process.env.API_KEY_PREFIX ?? 'sk-';
  const plaintext = `${prefix}${randomBytes(24).toString('base64url')}`;
  return {
    plaintext,
    hash: createHash('sha256').update(plaintext).digest('hex'),
    prefix: plaintext.slice(0, prefix.length + 6),
  };
}

const DEMO_MODELS = [
  { name: 'demo-gpt', displayName: 'Demo GPT', provider: 'openai', inputPrice: 1, outputPrice: 2 },
  { name: 'demo-claude', displayName: 'Demo Claude', provider: 'anthropic', inputPrice: 3, outputPrice: 15 },
  { name: 'demo-gemini', displayName: 'Demo Gemini', provider: 'gemini', inputPrice: 0.5, outputPrice: 1.5 },
];

const MODELS = [...COMMON_MODELS, ...DEMO_MODELS];

const CHANNELS = [
  { name: 'demo-openai-mock', provider: 'openai', baseUrl: `${UPSTREAM}/good/v1`, models: ['demo-gpt'] },
  { name: 'demo-anthropic-mock', provider: 'anthropic', baseUrl: `${UPSTREAM}/good/v1`, models: ['demo-claude'] },
  { name: 'demo-gemini-mock', provider: 'gemini', baseUrl: `${UPSTREAM}/good/v1beta`, models: ['demo-gemini'] },
];

async function seedAdmin() {
  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing) {
    if (existing.role !== Role.ADMIN) {
      await prisma.user.update({ where: { id: existing.id }, data: { role: Role.ADMIN } });
      console.log(`↑ 管理员权限已修正: ${ADMIN_EMAIL}`);
    } else {
      console.log(`= 管理员已存在: ${ADMIN_EMAIL}`);
    }
    return;
  }
  await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      username: ADMIN_USERNAME,
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
      role: Role.ADMIN,
    },
  });
  console.log(`+ 创建管理员: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
}

async function seedModels() {
  for (const m of MODELS) {
    await prisma.modelCatalog.upsert({
      where: { name: m.name },
      update: { displayName: m.displayName, provider: m.provider, inputPrice: m.inputPrice, outputPrice: m.outputPrice, enabled: true },
      create: { ...m, enabled: true },
    });
  }
  console.log(`= 模型目录已就绪 (${MODELS.length})`);
}

async function seedChannels() {
  for (const c of CHANNELS) {
    const existing = await prisma.channel.findFirst({
      where: { name: c.name, ownerType: ChannelOwnerType.PLATFORM },
    });
    const data = {
      provider: c.provider,
      baseUrl: c.baseUrl,
      apiKeyEnc: encrypt('mock-upstream-key'),
      models: c.models,
      status: ChannelStatus.ENABLED,
    };
    if (existing) {
      await prisma.channel.update({
        where: { id: existing.id },
        data: { ...data, failureCount: 0, autoDisabled: false, lastErrorMsg: null },
      });
    } else {
      await prisma.channel.create({
        data: { ...data, name: c.name, ownerType: ChannelOwnerType.PLATFORM, ownerUserId: null },
      });
    }
  }
  console.log(`= 平台渠道已就绪 (${CHANNELS.length}) → ${UPSTREAM}`);
}

async function seedDemoUser() {
  let user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: DEMO_EMAIL,
        username: DEMO_USERNAME,
        passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10),
        role: Role.USER,
      },
    });
    console.log(`+ 创建演示用户: ${DEMO_USERNAME} / ${DEMO_PASSWORD}`);
  } else {
    console.log(`= 演示用户已存在: ${DEMO_USERNAME}`);
  }

  const marker = 'demo seed 初始额度';
  const already = await prisma.balanceTransaction.findFirst({
    where: { userId: user.id, description: marker },
  });
  if (!already) {
    const balanceAfter = Number(user.balance) + DEMO_TOPUP;
    await prisma.user.update({ where: { id: user.id }, data: { balance: balanceAfter } });
    await prisma.balanceTransaction.create({
      data: { userId: user.id, type: 'RECHARGE', amount: DEMO_TOPUP, balanceAfter, description: marker },
    });
    console.log(`+ 演示账户充值 $${DEMO_TOPUP}`);
  } else {
    console.log('= 演示账户已有初始额度，跳过充值');
  }

  const keyCount = await prisma.apiKey.count({ where: { userId: user.id } });
  if (keyCount === 0) {
    const { plaintext, hash, prefix } = generateApiKey();
    await prisma.apiKey.create({
      data: { userId: user.id, name: 'demo-key', keyHash: hash, keyPrefix: prefix },
    });
    console.log(`\n  演示平台 Key（仅本次显示）: ${plaintext}\n`);
  } else {
    console.log('= 演示账户已有 API Key，跳过（明文不可再次获取）');
  }
}

async function main() {
  await seedAdmin();
  await seedModels();
  await seedChannels();
  await seedDemoUser();
  console.log('\n种子数据完成。http://localhost:5173  →  demo / demo123456');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
