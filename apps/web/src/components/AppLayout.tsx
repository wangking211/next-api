import { useMemo } from 'react';
import { Layout, Menu, Tag, Dropdown, Avatar, Typography } from 'antd';
import {
  DashboardOutlined,
  KeyOutlined,
  ApiOutlined,
  AppstoreOutlined,
  FileTextOutlined,
  LogoutOutlined,
  UserOutlined,
  WalletOutlined,
  TeamOutlined,
  GiftOutlined,
  AuditOutlined,
  TagsOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  const selectedKey = useMemo(() => {
    const match = ['/keys', '/channels', '/available-models', '/models', '/logs', '/billing', '/users', '/redeem-codes', '/audit-logs'].find((p) =>
      location.pathname.startsWith(p),
    );
    return match ?? '/dashboard';
  }, [location.pathname]);

  const items = [
    { key: '/dashboard', icon: <DashboardOutlined />, label: '总览' },
    { key: '/keys', icon: <KeyOutlined />, label: 'API Key' },
    { key: '/channels', icon: <ApiOutlined />, label: '渠道' },
    { key: '/available-models', icon: <TagsOutlined />, label: '可用模型' },
    { key: '/models', icon: <AppstoreOutlined />, label: '模型' },
    { key: '/logs', icon: <FileTextOutlined />, label: '调用日志' },
    { key: '/billing', icon: <WalletOutlined />, label: '余额与账单' },
    ...(user?.role === 'ADMIN'
      ? [
          { key: '/users', icon: <TeamOutlined />, label: '用户管理' },
          { key: '/redeem-codes', icon: <GiftOutlined />, label: '兑换码' },
          { key: '/audit-logs', icon: <AuditOutlined />, label: '操作审计' },
        ]
      : []),
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="0" theme="dark">
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: 600,
            fontSize: 16,
          }}
        >
          AI Gateway
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={items}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            paddingInline: 24,
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <Dropdown
            menu={{
              items: [
                {
                  key: 'logout',
                  icon: <LogoutOutlined />,
                  label: '退出登录',
                  onClick: () => {
                    logout();
                    navigate('/login');
                  },
                },
              ],
            }}
          >
            <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Avatar size="small" icon={<UserOutlined />} />
              <Text>{user?.username}</Text>
              {user?.role === 'ADMIN' && <Tag color="gold">管理员</Tag>}
            </div>
          </Dropdown>
        </Header>
        <Content style={{ margin: 16 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
