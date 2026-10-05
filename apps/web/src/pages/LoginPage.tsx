import { useEffect, useState } from 'react';
import { Alert, App, Button, Form, Input, Spin, Tabs } from 'antd';
import {
  CheckCircleFilled,
  LockOutlined,
  MailOutlined,
  SafetyCertificateOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAuth } from '../auth/AuthContext';
import { consumeSessionExpired, errorMessage } from '../api/client';
import { authApi } from '../api/endpoints';
import Logo from '../components/Logo';
import { LangSwitch } from '../components/LangSwitch';
import useDocumentTitle from '../hooks/useDocumentTitle';

const BRAND_POINTS = (t: TFunction) => [
  {
    icon: <ThunderboltOutlined />,
    title: t('auth.brand.points.compatible.title'),
    desc: t('auth.brand.points.compatible.desc'),
  },
  {
    icon: <SwapOutlined />,
    title: t('auth.brand.points.failover.title'),
    desc: t('auth.brand.points.failover.desc'),
  },
  {
    icon: <SafetyCertificateOutlined />,
    title: t('auth.brand.points.metering.title'),
    desc: t('auth.brand.points.metering.desc'),
  },
];

/** 只接受站内绝对路径，防开放重定向 */
function safeRedirect(raw: string | null): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/dashboard';
}

/** 三个标签页各自的标题/副标题（登录 / 注册 / 找回密码） */
function headCopy(key: string, t: TFunction) {
  if (key === 'reset') return { title: t('auth.head.resetTitle'), desc: t('auth.head.resetDesc') };
  if (key === 'register') {
    return { title: t('auth.head.registerTitle'), desc: t('auth.head.registerDesc') };
  }
  return { title: t('auth.head.loginTitle'), desc: t('auth.head.loginDesc') };
}

export default function LoginPage() {
  const { t, i18n } = useTranslation();
  const { user, loading: authLoading, login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = App.useApp();

  const [loginLoading, setLoginLoading] = useState(false);
  const [registerLoading, setRegisterLoading] = useState(false);
  const [activeKey, setActiveKey] = useState('login');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [loginForm] = Form.useForm();
  const [registerForm] = Form.useForm();
  const [resetForm] = Form.useForm();
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  // 邮件通道开关：SMTP 未配置时注册免验证码、也不展示「忘记密码」标签页
  const [mailEnabled, setMailEnabled] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  // 服务端下发的重发冷却（秒），到 0 才允许再次发送
  const [codeCooldown, setCodeCooldown] = useState(0);

  // 401 被动登出跳过来时给一次明确提示，避免用户以为「莫名其妙要重新登录」
  useEffect(() => {
    if (consumeSessionExpired()) setLoginNotice(t('api.unauthorized'));
  }, [t]);

  // 拉取邮件通道状态；失败按未启用渲染，登录/注册流程与改造前完全一致
  useEffect(() => {
    let alive = true;
    authApi
      .mailStatus()
      .then((s) => {
        if (alive) setMailEnabled(s.enabled);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 重发倒计时
  useEffect(() => {
    if (codeCooldown <= 0) return;
    const timer = setTimeout(() => setCodeCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [codeCooldown]);

  useDocumentTitle(
    activeKey === 'reset'
      ? t('auth.docTitle.reset')
      : activeKey === 'register'
        ? t('auth.docTitle.register')
        : t('auth.docTitle.login'),
  );

  const target = safeRedirect(new URLSearchParams(location.search).get('redirect'));
  const head = headCopy(activeKey, t);

  if (authLoading) {
    return (
      <div className="auth-page">
        <div className="auth-panel">
          <Spin size="large" />
        </div>
      </div>
    );
  }

  // 已登录用户直接进入目标页面
  if (user) return <Navigate to={target} replace />;

  const handleLogin = async (values: { identifier: string; password: string }) => {
    setLoginLoading(true);
    setLoginError(null);
    setLoginNotice(null);
    try {
      await login(values.identifier, values.password);
      navigate(target, { replace: true });
    } catch (e) {
      const status = (e as any)?.response?.status;
      if (status === 429) {
        setLoginError(t('auth.login.errorTooManyAttempts'));
      } else {
        setLoginError(errorMessage(e));
      }
    } finally {
      setLoginLoading(false);
    }
  };

  const handleRegister = async (values: {
    email: string;
    username: string;
    password: string;
    emailCode?: string;
  }) => {
    setRegisterLoading(true);
    setRegisterError(null);
    try {
      await register(
        values.email,
        values.username,
        values.password,
        mailEnabled ? values.emailCode : undefined,
      );
      message.success(t('auth.register.success'));
      navigate(target, { replace: true });
    } catch (e) {
      const status = (e as any)?.response?.status;
      if (status === 409) {
        setLoginNotice(t('auth.register.alreadyExists'));
        loginForm.setFieldValue('identifier', values.email || values.username);
        setActiveKey('login');
      } else {
        setRegisterError(errorMessage(e));
      }
    } finally {
      setRegisterLoading(false);
    }
  };

  /**
   * 发送邮箱验证码（注册 / 找回密码共用）。
   * 先就地校验邮箱字段——邮箱不对就没必要让服务端白白消耗一次发送额度。
   */
  const sendCode = async (purpose: 'register' | 'reset') => {
    const form = purpose === 'register' ? registerForm : resetForm;
    // 校验失败时字段已就地标红，这里静默返回；成功才拿到邮箱
    const email = await form.validateFields(['email']).then(
      (v) => String(v.email ?? '').trim(),
      () => null,
    );
    if (!email) return;
    setSendingCode(true);
    try {
      const { cooldownSeconds } = await authApi.sendEmailCode(email, purpose, i18n.language);
      setCodeCooldown(cooldownSeconds);
      message.success(t('auth.form.codeSent'));
    } catch (e) {
      const err = errorMessage(e);
      if (purpose === 'register') setRegisterError(err);
      else setResetError(err);
    } finally {
      setSendingCode(false);
    }
  };

  /** 服务端重发冷却优先：倒计时期间按钮禁用，文案显示剩余秒数 */
  const sendCodeButton = (purpose: 'register' | 'reset') => (
    <Button
      type="link"
      size="small"
      loading={sendingCode}
      disabled={codeCooldown > 0}
      onClick={() => void sendCode(purpose)}
    >
      {codeCooldown > 0
        ? t('auth.form.codeResendIn', { seconds: codeCooldown })
        : t('auth.form.sendCode')}
    </Button>
  );

  const handleReset = async (values: { email: string; code: string; password: string }) => {
    setResetLoading(true);
    setResetError(null);
    try {
      await authApi.resetPassword(values.email.trim(), values.code, values.password);
      message.success(t('auth.reset.success'));
      resetForm.resetFields();
      setCodeCooldown(0);
      // 带着邮箱回登录页，用户只需输新密码
      loginForm.setFieldValue('identifier', values.email.trim());
      setActiveKey('login');
    } catch (e) {
      setResetError(errorMessage(e));
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <div className="auth-page">
      {/* 品牌侧（窄屏隐藏） */}
      <aside className="auth-brand">
        <Link to="/" className="lp-logo" style={{ color: 'var(--ink-text)' }}>
          <Logo size={26} onDark />
          <span>AI Gateway</span>
        </Link>

        <div>
          <h1>
            {t('auth.brand.titleLead')}
            <em>{t('auth.brand.titleAccent')}</em>
          </h1>
          <p>{t('auth.brand.desc')}</p>
          <div className="auth-points">
            {BRAND_POINTS(t).map((p) => (
              <div className="auth-point" key={p.title}>
                <span>
                  <CheckCircleFilled />
                </span>
                <div>
                  <b>{p.title}</b>
                  <small>{p.desc}</small>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="auth-brand-foot">
          © {new Date().getFullYear()} AI Gateway · <Link to="/">{t('auth.brand.backHome')}</Link>
        </div>
      </aside>

      {/* 表单侧 */}
      <main className="auth-panel">
        <div className="auth-card">
          <Link to="/" className="auth-mobile-brand">
            <Logo size={24} />
            <span>AI Gateway</span>
          </Link>

          <div className="auth-head">
            <h2>{head.title}</h2>
            <p>{head.desc}</p>
          </div>

          <Tabs
            centered
            activeKey={activeKey}
            onChange={(key) => {
              setActiveKey(key);
              setLoginError(null);
              setLoginNotice(null);
              setRegisterError(null);
              setResetError(null);
              // 冷却按邮箱+用途分别计，切标签后按 0 起算，让按钮状态与当前表单一致
              setCodeCooldown(0);
            }}
            items={[
              {
                key: 'login',
                label: t('auth.tab.login'),
                children: (
                  <>
                    {loginNotice && (
                      <Alert
                        type="info"
                        showIcon
                        message={loginNotice}
                        style={{ marginBottom: 16 }}
                      />
                    )}
                    {loginError && (
                      <Alert
                        type="error"
                        showIcon
                        message={loginError}
                        style={{ marginBottom: 16 }}
                      />
                    )}
                    <Form
                      form={loginForm}
                      layout="vertical"
                      onFinish={handleLogin}
                      requiredMark={false}
                      size="large"
                    >
                      <Form.Item
                        name="identifier"
                        label={t('auth.form.identifierLabel')}
                        rules={[{ required: true, message: t('auth.form.identifierRequired') }]}
                      >
                        <Input
                          prefix={<UserOutlined />}
                          placeholder={t('auth.form.identifierPlaceholder')}
                          autoComplete="username"
                        />
                      </Form.Item>
                      <Form.Item
                        name="password"
                        label={t('auth.form.passwordLabel')}
                        rules={[{ required: true, message: t('auth.form.passwordRequired') }]}
                      >
                        <Input.Password
                          prefix={<LockOutlined />}
                          placeholder={t('auth.form.passwordPlaceholder')}
                          autoComplete="current-password"
                        />
                      </Form.Item>
                      <Button
                        type="primary"
                        htmlType="submit"
                        block
                        loading={loginLoading}
                        size="large"
                      >
                        {t('auth.form.loginButton')}
                      </Button>
                    </Form>
                  </>
                ),
              },
              {
                key: 'register',
                label: t('auth.tab.register'),
                children: (
                  <>
                    {registerError && (
                      <Alert
                        type="error"
                        showIcon
                        message={registerError}
                        style={{ marginBottom: 16 }}
                      />
                    )}
                    <Form
                      form={registerForm}
                      layout="vertical"
                      onFinish={handleRegister}
                      requiredMark={false}
                      size="large"
                    >
                      <Form.Item
                        name="email"
                        label={t('auth.form.emailLabel')}
                        rules={[
                          { required: true, message: t('auth.form.emailRequired') },
                          { type: 'email', message: t('auth.form.emailInvalid') },
                        ]}
                      >
                        <Input
                          prefix={<MailOutlined />}
                          placeholder="you@example.com"
                          autoComplete="email"
                        />
                      </Form.Item>
                      <Form.Item
                        name="username"
                        label={t('auth.form.usernameLabel')}
                        rules={[
                          { required: true, message: t('auth.form.usernameRequired') },
                          { min: 3, message: t('auth.form.usernameMinLength') },
                          {
                            pattern: /^[a-zA-Z0-9_]+$/,
                            message: t('auth.form.usernamePattern'),
                          },
                        ]}
                      >
                        <Input
                          prefix={<UserOutlined />}
                          placeholder="username"
                          autoComplete="username"
                        />
                      </Form.Item>
                      <Form.Item
                        name="password"
                        label={t('auth.form.passwordLabel')}
                        extra={t('auth.form.passwordExtra')}
                        rules={[
                          { required: true, message: t('auth.form.passwordRequired') },
                          { min: 8, message: t('auth.form.passwordMinLength') },
                          {
                            pattern: /(?=.*[A-Za-z])(?=.*\d)/,
                            message: t('auth.form.passwordComplexity'),
                          },
                        ]}
                      >
                        <Input.Password
                          prefix={<LockOutlined />}
                          placeholder={t('auth.form.passwordRegisterPlaceholder')}
                          autoComplete="new-password"
                        />
                      </Form.Item>
                      {/* 邮箱验证码：仅在服务端配置了 SMTP 时出现 */}
                      {mailEnabled && (
                        <Form.Item
                          name="emailCode"
                          label={t('auth.form.codeLabel')}
                          rules={[
                            { required: true, message: t('auth.form.codeRequired') },
                            { pattern: /^\d{6}$/, message: t('auth.form.codePattern') },
                          ]}
                        >
                          <Input
                            prefix={<SafetyCertificateOutlined />}
                            placeholder={t('auth.form.codePlaceholder')}
                            maxLength={6}
                            autoComplete="one-time-code"
                            addonAfter={sendCodeButton('register')}
                          />
                        </Form.Item>
                      )}
                      <Button
                        type="primary"
                        htmlType="submit"
                        block
                        loading={registerLoading}
                        size="large"
                      >
                        {t('auth.form.registerButton')}
                      </Button>
                    </Form>
                  </>
                ),
              },
              // SMTP 未配置时后端对找回密码返回 503，故整个标签页不展示
              ...(mailEnabled
                ? [
                    {
                      key: 'reset',
                      label: t('auth.tab.reset'),
                      children: (
                        <>
                          {resetError && (
                            <Alert
                              type="error"
                              showIcon
                              message={resetError}
                              style={{ marginBottom: 16 }}
                            />
                          )}
                          <Form
                            form={resetForm}
                            layout="vertical"
                            onFinish={handleReset}
                            requiredMark={false}
                            size="large"
                          >
                            <Form.Item
                              name="email"
                              label={t('auth.form.emailLabel')}
                              rules={[
                                { required: true, message: t('auth.form.emailRequired') },
                                { type: 'email', message: t('auth.form.emailInvalid') },
                              ]}
                            >
                              <Input
                                prefix={<MailOutlined />}
                                placeholder="you@example.com"
                                autoComplete="email"
                              />
                            </Form.Item>
                            <Form.Item
                              name="code"
                              label={t('auth.form.codeLabel')}
                              rules={[
                                { required: true, message: t('auth.form.codeRequired') },
                                { pattern: /^\d{6}$/, message: t('auth.form.codePattern') },
                              ]}
                            >
                              <Input
                                prefix={<SafetyCertificateOutlined />}
                                placeholder={t('auth.form.codePlaceholder')}
                                maxLength={6}
                                autoComplete="one-time-code"
                                addonAfter={sendCodeButton('reset')}
                              />
                            </Form.Item>
                            <Form.Item
                              name="password"
                              label={t('auth.form.newPasswordLabel')}
                              extra={t('auth.form.passwordExtra')}
                              rules={[
                                { required: true, message: t('auth.form.passwordRequired') },
                                { min: 8, message: t('auth.form.passwordMinLength') },
                                {
                                  pattern: /(?=.*[A-Za-z])(?=.*\d)/,
                                  message: t('auth.form.passwordComplexity'),
                                },
                              ]}
                            >
                              <Input.Password
                                prefix={<LockOutlined />}
                                placeholder={t('auth.form.passwordRegisterPlaceholder')}
                                autoComplete="new-password"
                              />
                            </Form.Item>
                            <Button
                              type="primary"
                              htmlType="submit"
                              block
                              loading={resetLoading}
                              size="large"
                            >
                              {t('auth.form.resetButton')}
                            </Button>
                          </Form>
                        </>
                      ),
                    },
                  ]
                : []),
            ]}
          />

          <div className="auth-foot">
            <LangSwitch />
            <br />
            {t('auth.foot.help')}
            <br />
            <Link to="/">{t('auth.foot.backHome')}</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
