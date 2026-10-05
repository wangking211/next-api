#!/usr/bin/env node

/**
 * 发布后线上验收：不碰网关生成接口（/v1/**），只验证控制台鉴权与邮件相关链路。
 *
 * 检查项：
 *   1. 站点可达（GET / 200），且前端 bundle 里带「忘记密码」入口
 *   2. GET /api/auth/mail-status 200 且带 enabled 布尔（决定后面两问的期望值）
 *   3. forgot-password / email-code 的响应与「SMTP 是否已配置」一致
 *   4. 错误口令登录 → 401
 *   5. 管理员自重置口令往返：改临时口令 → 原口令 401 → 临时口令 201 → 还原 → 原口令 201
 *      （写操作，跑完口令还原成 AIGW_PASSWORD。用管理员自己往返，是因为线上没有删除用户的接口，
 *        注册临时账号会永久残留）
 *   6. 可选：验证「SMTP 未配置时免验证码注册」（默认关闭，见下）
 *
 * 运行：
 *   AIGW_PASSWORD=... node tools/verify/deploy-acceptance.mjs
 *   AIGW_PASSWORD=... AIGW_VERIFY_REGISTER=true node tools/verify/deploy-acceptance.mjs
 *
 * 环境变量见 lib.mjs；额外：
 *   AIGW_VERIFY_REGISTER  true = 额外注册一个临时账号验证免验证码注册。
 *                         注意：线上无删除用户接口，该账号会永久残留，默认关闭。
 */

import { adminPassword, api, base, checker, identifier, passwordLogin } from './lib.mjs';

const { check, done } = checker();

if (!adminPassword) {
  console.error('本验收需要 AIGW_PASSWORD（口令往返测试要拿它做新旧对照）。');
  process.exit(2);
}
console.log(`base=${base} identifier=${identifier}`);

// ---------- 1. 站点与前端 ----------
const home = await api('GET', '/', { timeoutMs: 30000 });
check('站点可达 GET / = 200', home.status === 200, home.status);

const assets = [...(home.text ?? '').matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map(
  (m) => m[1],
);
let bundleHasReset = false;
for (const asset of assets) {
  const r = await api('GET', asset, { timeoutMs: 30000 });
  if (r.text?.includes('auth.tab.reset')) {
    bundleHasReset = true;
    break;
  }
}
check(
  `前端 bundle 含「忘记密码」入口（扫描 ${assets.length} 个 asset）`,
  bundleHasReset,
  'auth.tab.reset 未在 /assets/*.js 中出现（若 i18n 键改名请同步更新本检查）',
);

// ---------- 2. 邮件通道状态 ----------
const status = await api('GET', '/api/auth/mail-status');
check(
  'mail-status 200 且带 enabled 布尔',
  status.status === 200 && typeof status.json?.enabled === 'boolean',
  { status: status.status, body: status.json },
);
const mailEnabled = status.json?.enabled === true;
console.log(
  `      邮件通道：${mailEnabled ? 'ENABLED（SMTP 已配置）' : 'DISABLED（注册保持免验证码）'}`,
);

// ---------- 3. 找回密码 / 验证码端点 ----------
const probeEmail = `probe-${Date.now().toString(36)}@example.com`;
const forgot = await api('POST', '/api/auth/forgot-password', {
  body: { email: probeEmail, locale: 'zh-CN' },
});
if (mailEnabled) {
  check('SMTP 已配置时 forgot-password 可用（200）', forgot.status === 200, forgot);
} else {
  check(
    'SMTP 未配置时 forgot-password = 503 AUTH_MAIL_NOT_CONFIGURED',
    forgot.status === 503 && forgot.json?.code === 'AUTH_MAIL_NOT_CONFIGURED',
    { status: forgot.status, body: forgot.json },
  );
}

const code = await api('POST', '/api/auth/email-code', {
  body: { email: probeEmail, purpose: 'register', locale: 'zh-CN' },
});
if (mailEnabled) {
  // 200 = 已发码；429 = 同邮箱重发冷却，两者都说明链路通
  check('SMTP 已配置时 email-code 有响应（200/429）', code.status === 200 || code.status === 429, {
    status: code.status,
    body: code.json,
  });
} else {
  check(
    'SMTP 未配置时 email-code = 503 AUTH_MAIL_NOT_CONFIGURED',
    code.status === 503 && code.json?.code === 'AUTH_MAIL_NOT_CONFIGURED',
    { status: code.status, body: code.json },
  );
}

// ---------- 4. 错误口令登录 ----------
const bad = await passwordLogin(identifier, 'definitely-not-the-password');
check('错误口令登录 = 401', bad.status === 401, { status: bad.status, body: bad.json });

// ---------- 5. 管理员自重置口令往返（写操作，跑完必须还原）----------
const tempPw = `Tmp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const first = await passwordLogin(identifier, adminPassword);
check('用 AIGW_PASSWORD 登录 = 201', first.status === 201 && !!first.json?.accessToken, {
  status: first.status,
  body: first.json,
});

const uid = first.json?.user?.id;
const tok1 = first.json?.accessToken;
if (tok1 && uid) {
  const reset1 = await api('POST', `/api/admin/users/${uid}/reset-password`, {
    body: { password: tempPw },
    token: tok1,
    timeoutMs: 30000,
  });
  check('管理员重置口令为临时值', reset1.ok, { status: reset1.status, body: reset1.json });

  if (reset1.ok) {
    const tmpLogin = await passwordLogin(identifier, tempPw);
    const tok2 = tmpLogin.json?.accessToken ?? null;
    check('临时口令登录 = 201', tmpLogin.status === 201 && !!tok2, { status: tmpLogin.status });

    // 先确认拿得到新令牌，再去做「原口令必须 401」的对照，避免把自己锁死
    const old = await passwordLogin(identifier, adminPassword);
    check('原口令被拒 = 401（tokenVersion 已递增）', old.status === 401, { status: old.status });

    if (tok2) {
      const restore = await api('POST', `/api/admin/users/${uid}/reset-password`, {
        body: { password: adminPassword },
        token: tok2,
        timeoutMs: 30000,
      });
      check('还原原口令', restore.ok, { status: restore.status, body: restore.json });
      if (restore.ok) {
        const again = await passwordLogin(identifier, adminPassword);
        check('原口令恢复登录 = 201', again.status === 201, { status: again.status });
      }
    } else {
      console.error(
        `\nCRITICAL: 拿不到临时口令的令牌，无法自动还原。当前 ${identifier} 口令 = ${tempPw}` +
          `\n请用它登录后手动改回 AIGW_PASSWORD。base=${base}`,
      );
      process.exitCode = 1;
    }
  }
}

// ---------- 6. 可选：免验证码注册（会产生永久残留账号，默认关闭）----------
if (process.env.AIGW_VERIFY_REGISTER !== 'true') {
  console.log('\nSKIP 免验证码注册验证（需 AIGW_VERIFY_REGISTER=true，会残留一个永久账号）');
} else if (mailEnabled) {
  console.log('\nSKIP 免验证码注册验证：SMTP 已配置，此时注册必须带验证码，非本项范围');
} else {
  const stamp = Date.now().toString().slice(-8);
  const reg = await api('POST', '/api/auth/register', {
    body: {
      email: `verify${stamp}@example.com`,
      username: `verify${stamp}`,
      password: 'Verify123456',
    },
  });
  check('SMTP 未配置时注册免验证码 = 201', reg.status === 201 && !!reg.json?.accessToken, {
    status: reg.status,
    body: reg.json,
  });
  console.log('      注意：线上无删除用户接口，该临时账号会永久残留。');
}

done();
