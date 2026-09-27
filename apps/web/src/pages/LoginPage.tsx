import { useState } from 'react';
import { App, Button, Card, Form, Input, Tabs, Typography } from 'antd';
import { LockOutlined, MailOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../api/client';

const { Title, Paragraph } = Typography;

export default function LoginPage() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [loginLoading, setLoginLoading] = useState(false);
  const [registerLoading, setRegisterLoading] = useState(false);
  const [activeKey, setActiveKey] = useState('login');
  const [loginForm] = Form.useForm();
  const [registerForm] = Form.useForm();

  const handleLogin = async (values: { identifier: string; password: string }) => {
    setLoginLoading(true);
    try {
      await login(values.identifier, values.password);
      navigate('/dashboard');
    } catch (e) {
      const status = (e as any)?.response?.status;
      if (status === 429) {
        message.warning('登录失败次数过多，请稍后再试');
      } else {
        message.error(errorMessage(e));
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
    try {
      await register(values.email, values.username, values.password);
      message.success('注册成功');
      navigate('/dashboard');
    } catch (e) {
      const status = (e as any)?.response?.status;
      if (status === 409) {
        message.warning('该邮箱或用户名已被注册，请直接登录');
        loginForm.setFieldValue('identifier', values.email || values.username);
        setActiveKey('login');
      } else {
        message.error(errorMessage(e));
      }
    } finally {
      setRegisterLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
      }}
    >
      <Card style={{ width: 400, maxWidth: '100%', margin: 16 }}>
        <Title level={3} style={{ textAlign: 'center', marginBottom: 4 }}>
          AI Gateway
        </Title>
        <Paragraph type="secondary" style={{ textAlign: 'center' }}>
          多模型 AI API 中转与管理控制台
        </Paragraph>
        <Tabs
          centered
          activeKey={activeKey}
          onChange={setActiveKey}
          items={[
            {
              key: 'login',
              label: '登录',
              children: (
                <Form form={loginForm} layout="vertical" onFinish={handleLogin} requiredMark={false}>
                  <Form.Item
                    name="identifier"
                    label="邮箱或用户名"
                    rules={[{ required: true, message: '请输入邮箱或用户名' }]}
                  >
                    <Input prefix={<UserOutlined />} placeholder="admin 或 admin@aigw.local" />
                  </Form.Item>
                  <Form.Item
                    name="password"
                    label="密码"
                    rules={[{ required: true, message: '请输入密码' }]}
                  >
                    <Input.Password prefix={<LockOutlined />} placeholder="密码" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" block loading={loginLoading}>
                    登录
                  </Button>
                </Form>
              ),
            },
            {
              key: 'register',
              label: '注册',
              children: (
                <Form form={registerForm} layout="vertical" onFinish={handleRegister} requiredMark={false}>
                  <Form.Item
                    name="email"
                    label="邮箱"
                    rules={[
                      { required: true, message: '请输入邮箱' },
                      { type: 'email', message: '邮箱格式不正确' },
                    ]}
                  >
                    <Input prefix={<MailOutlined />} placeholder="you@example.com" />
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
                    <Input prefix={<UserOutlined />} placeholder="username" />
                  </Form.Item>
                  <Form.Item
                    name="password"
                    label="密码"
                    rules={[
                      { required: true, message: '请输入密码' },
                      { min: 8, message: '至少 8 个字符' },
                      {
                        pattern: /(?=.*[A-Za-z])(?=.*\d)/,
                        message: '需同时包含字母和数字',
                      },
                    ]}
                  >
                    <Input.Password prefix={<LockOutlined />} placeholder="至少 8 位，含字母和数字" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" block loading={registerLoading}>
                    注册
                  </Button>
                </Form>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
