import { useState } from 'react';
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
import { errorMessage } from '../api/client';
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

export default function LoginPage() {
  const { t } = useTranslation();
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

  useDocumentTitle(activeKey === 'login' ? t('auth.docTitle.login') : t('auth.docTitle.register'));

  const target = safeRedirect(new URLSearchParams(location.search).get('redirect'));

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
  }) => {
    setRegisterLoading(true);
    setRegisterError(null);
    try {
      await register(values.email, values.username, values.password);
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
            <h2>
              {activeKey === 'login' ? t('auth.head.loginTitle') : t('auth.head.registerTitle')}
            </h2>
            <p>
              {activeKey === 'login' ? t('auth.head.loginDesc') : t('auth.head.registerDesc')}
            </p>
          </div>

          <Tabs
            centered
            activeKey={activeKey}
            onChange={(key) => {
              setActiveKey(key);
              setLoginError(null);
              setLoginNotice(null);
              setRegisterError(null);
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
