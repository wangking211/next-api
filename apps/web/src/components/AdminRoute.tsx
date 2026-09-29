import { Result } from 'antd';
import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';

/** 仅管理员可访问的路由组；非管理员返回 403 而非渲染页面 */
export default function AdminRoute() {
  const { user } = useAuth();
  const { t } = useTranslation();
  if (user?.role !== 'ADMIN') {
    return (
      <Result status="403" title="403" subTitle={t('layout.adminRoute.forbidden')} />
    );
  }
  return <Outlet />;
}
