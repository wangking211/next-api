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
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../api/client';
import Logo from '../components/Logo';
import useDocumentTitle from '../hooks/useDocumentTitle';

const BRAND_POINTS = [
  {
    icon: <ThunderboltOutlined />,
    title: 'OpenAI 兼容接口',
    desc: '一行 base_url 替换即可接入现有 SDK，流式 SSE 原生支持。',
  },
  {
    icon: <SwapOutlined />,
    title: '多渠道自动故障转移',
    desc: '上游异常自动切换下一渠道，按优先级与权重路由。',
  },
  {
    icon: <SafetyCertificateOutlined />,
    title: '按 token 精确结算',
    desc: '输入 / 输出 / 缓存读写分列计价，账单逐笔可查、可导出。',
  },
];

/** 只接受站内绝对路径，防开放重定向 */
function safeRedirect(raw: string | null): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/dashboard';
}

export default function LoginPage() {
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

  useDocumentTitle(activeKey === 'login' ? '登录' : '注册');

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
        setLoginError('登录失败次数过多，请稍后再试。');
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
      message.success('注册成功');
      navigate(target, { replace: true });
    } catch (e) {
      const status = (e as any)?.response?.status;
      if (status === 409) {
        setLoginNotice('该邮箱或用户名已被注册，请直接登录。');
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
            一个 API，<em>接入全部主流大模型</em>
          </h1>
          <p>
            OpenAI 兼容协议，聚合多家上游服务商，自动故障转移，按 token
            精确计量与结算。登录后即可创建 Key、查看账单与调用日志。
          </p>
          <div className="auth-points">
            {BRAND_POINTS.map((p) => (
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
          © {new Date().getFullYear()} AI Gateway · <Link to="/">返回首页</Link>
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
            <h2>{activeKey === 'login' ? '登录控制台' : '创建账号'}</h2>
            <p>
              {activeKey === 'login'
                ? '使用邮箱或用户名继续，登录后跳转到你原本要访问的页面。'
                : '注册即用，无需商务对接；创建 Key 后一分钟内发出第一条请求。'}
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
                label: '登录',
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
                        label="邮箱或用户名"
                        rules={[{ required: true, message: '请输入邮箱或用户名' }]}
                      >
                        <Input
                          prefix={<UserOutlined />}
                          placeholder="admin 或 admin@aigw.local"
                          autoComplete="username"
                        />
                      </Form.Item>
                      <Form.Item
                        name="password"
                        label="密码"
                        rules={[{ required: true, message: '请输入密码' }]}
                      >
                        <Input.Password
                          prefix={<LockOutlined />}
                          placeholder="密码"
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
                        登录
                      </Button>
                    </Form>
                  </>
                ),
              },
              {
                key: 'register',
                label: '注册',
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
                        label="邮箱"
                        rules={[
                          { required: true, message: '请输入邮箱' },
                          { type: 'email', message: '邮箱格式不正确' },
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
                        label="用户名"
                        rules={[
                          { required: true, message: '请输入用户名' },
                          { min: 3, message: '至少 3 个字符' },
                          { pattern: /^[a-zA-Z0-9_]+$/, message: '只能包含字母、数字和下划线' },
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
                        label="密码"
                        extra="至少 8 位，且同时包含字母和数字"
                        rules={[
                          { required: true, message: '请输入密码' },
                          { min: 8, message: '至少 8 个字符' },
                          {
                            pattern: /(?=.*[A-Za-z])(?=.*\d)/,
                            message: '需同时包含字母和数字',
                          },
                        ]}
                      >
                        <Input.Password
                          prefix={<LockOutlined />}
                          placeholder="至少 8 位，含字母和数字"
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
                        注册
                      </Button>
                    </Form>
                  </>
                ),
              },
            ]}
          />

          <div className="auth-foot">
            遇到问题可联系管理员开通账号。
            <br />
            <Link to="/">← 返回首页</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
