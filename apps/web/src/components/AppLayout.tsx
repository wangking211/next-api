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
  ClusterOutlined,
} from '@ant-design/icons';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import Logo from './Logo';
import { LangSwitch } from './LangSwitch';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const { t, i18n } = useTranslation();

  const isAdmin = user?.role === 'ADMIN';

  /** 控制台各页的 document.title（SPA 无路由级标题管理，在外壳统一维护） */
  const PAGE_TITLES: Record<string, string> = {
    '/dashboard': t('layout.title.dashboard'),
    '/keys': 'API Key',
    '/channels': t('layout.title.channels'),
    '/available-models': t('layout.title.availableModels'),
    '/models': t('layout.title.models'),
    '/logs': t('layout.title.logs'),
    '/usage-stats': t('layout.title.usageStats'),
    '/billing': t('layout.title.billing'),
    '/agent': t('layout.title.agent'),
    '/users': t('layout.title.users'),
    '/groups': t('layout.title.groups'),
    '/redeem-codes': t('layout.title.redeemCodes'),
    '/audit-logs': t('layout.title.auditLogs'),
    '/withdrawals': t('layout.title.withdrawals'),
  };

  const selectedKey = useMemo(() => {
    const match = ['/keys', '/channels', '/available-models', '/models', '/logs', '/usage-stats', '/billing', '/agent', '/users', '/groups', '/redeem-codes', '/audit-logs', '/withdrawals'].find((p) =>
      location.pathname.startsWith(p),
    );
    return match ?? '/dashboard';
  }, [location.pathname]);

  useEffect(() => {
    const title =
      (selectedKey === '/channels' && !isAdmin
        ? t('layout.title.myChannels')
        : PAGE_TITLES[selectedKey]) ?? t('layout.title.fallback');
    document.title = `${title} · AI Gateway`;
  }, [selectedKey, isAdmin, i18n.language]);

  const items = [
    { key: '/dashboard', icon: <DashboardOutlined />, label: t('layout.menu.overview') },
    { key: '/keys', icon: <KeyOutlined />, label: 'API Key' },
    // 普通用户只看得到自己的 BYOK 渠道，改名避免误认为平台管理后台
    {
      key: '/channels',
      icon: <ApiOutlined />,
      label: isAdmin ? t('layout.menu.channels') : t('layout.menu.myChannels'),
    },
    { key: '/available-models', icon: <TagsOutlined />, label: t('layout.menu.availableModels') },
    { key: '/models', icon: <AppstoreOutlined />, label: t('layout.menu.models') },
    { key: '/logs', icon: <FileTextOutlined />, label: t('layout.menu.logs') },
    { key: '/usage-stats', icon: <BarChartOutlined />, label: t('layout.menu.usageStats') },
    { key: '/billing', icon: <WalletOutlined />, label: t('layout.menu.billing') },
    ...(user?.role === 'AGENT' || user?.role === 'ADMIN'
      ? [{ key: '/agent', icon: <ApartmentOutlined />, label: t('layout.menu.agent') }]
      : []),
    ...(user?.role === 'ADMIN'
      ? [
          { key: '/users', icon: <TeamOutlined />, label: t('layout.menu.users') },
          { key: '/groups', icon: <ClusterOutlined />, label: t('layout.menu.groups') },
          { key: '/redeem-codes', icon: <GiftOutlined />, label: t('layout.menu.redeemCodes') },
          { key: '/audit-logs', icon: <AuditOutlined />, label: t('layout.menu.auditLogs') },
          { key: '/withdrawals', icon: <WalletOutlined />, label: t('layout.menu.withdrawals') },
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
          <LangSwitch />
          <Dropdown
            menu={{
              items: [
                {
                  key: 'logout',
                  icon: <LogoutOutlined />,
                  label: t('layout.user.signOut'),
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
              {user?.role === 'ADMIN' && <Tag color="gold">{t('layout.user.adminTag')}</Tag>}
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
