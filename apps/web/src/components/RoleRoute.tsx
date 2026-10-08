import { Result } from 'antd';
import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import type { UserInfo } from '../api/types';

/**
 * 限定角色可访问的路由组（如 /agent 仅代理与管理员）；
 * 角色不符时返回 403 结果页而非渲染页面——菜单隐藏只是展示层，直达 URL 也必须被拦下。
 */
export default function RoleRoute({ roles }: { roles: UserInfo['role'][] }) {
  const { user } = useAuth();
  const { t } = useTranslation();
  if (!user || !roles.includes(user.role)) {
    return <Result status="403" title="403" subTitle={t('layout.roleRoute.forbidden')} />;
  }
  return <Outlet />;
}
