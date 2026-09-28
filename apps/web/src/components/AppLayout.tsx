import { useEffect, useMemo } from 'react';
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
  BarChartOutlined,
  ApartmentOutlined,
} from '@ant-design/icons';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import Logo from './Logo';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

/** 控制台各页的 document.title（SPA 无路由级标题管理，在外壳统一维护） */
const PAGE_TITLES: Record<string, string> = {
  '/dashboard': '总览',
  '/keys': 'API Key',
  '/channels': '渠道',
  '/available-models': '可用模型',
  '/models': '模型定价',
  '/logs': '调用日志',
  '/usage-stats': '使用统计',
  '/billing': '余额与账单',
  '/agent': '代理中心',
  '/users': '用户管理',
  '/redeem-codes': '兑换码',
  '/audit-logs': '操作审计',
  '/withdrawals': '提现管理',
};

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  const isAdmin = user?.role === 'ADMIN';

  const selectedKey = useMemo(() => {
    const match = ['/keys', '/channels', '/available-models', '/models', '/logs', '/usage-stats', '/billing', '/agent', '/users', '/redeem-codes', '/audit-logs', '/withdrawals'].find((p) =>
      location.pathname.startsWith(p),
    );
    return match ?? '/dashboard';
  }, [location.pathname]);

  useEffect(() => {
    const title =
      (selectedKey === '/channels' && !isAdmin
        ? '我的渠道'
        : PAGE_TITLES[selectedKey]) ?? '控制台';
    document.title = `${title} · AI Gateway`;
  }, [selectedKey, isAdmin]);

  const items = [
    { key: '/dashboard', icon: <DashboardOutlined />, label: '总览' },
    { key: '/keys', icon: <KeyOutlined />, label: 'API Key' },
    // 普通用户只看得到自己的 BYOK 渠道，改名避免误认为平台管理后台
    { key: '/channels', icon: <ApiOutlined />, label: isAdmin ? '渠道' : '我的渠道' },
    { key: '/available-models', icon: <TagsOutlined />, label: '可用模型' },
    { key: '/models', icon: <AppstoreOutlined />, label: '模型' },
    { key: '/logs', icon: <FileTextOutlined />, label: '调用日志' },
    { key: '/usage-stats', icon: <BarChartOutlined />, label: '使用统计' },
    { key: '/billing', icon: <WalletOutlined />, label: '余额与账单' },
    ...(user?.role === 'AGENT' || user?.role === 'ADMIN'
      ? [{ key: '/agent', icon: <ApartmentOutlined />, label: '代理中心' }]
      : []),
    ...(user?.role === 'ADMIN'
      ? [
          { key: '/users', icon: <TeamOutlined />, label: '用户管理' },
          { key: '/redeem-codes', icon: <GiftOutlined />, label: '兑换码' },
          { key: '/audit-logs', icon: <AuditOutlined />, label: '操作审计' },
          { key: '/withdrawals', icon: <WalletOutlined />, label: '提现管理' },
        ]
      : []),
  ];

  return (
    <Layout className="app-shell">
      <Sider breakpoint="lg" collapsedWidth="0" theme="dark">
        <div className="app-brand">
          <Link to="/" className="app-brand-link">
            <Logo size={22} onDark />
            <span>AI Gateway</span>
          </Link>
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
        <Header className="app-header">
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
            <div className="app-user">
              <Avatar size="small" icon={<UserOutlined />} />
              <Text>{user?.username}</Text>
              {user?.role === 'ADMIN' && <Tag color="gold">管理员</Tag>}
            </div>
          </Dropdown>
        </Header>
        <Content className="app-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
