import { Result } from 'antd';
import { Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

/** 仅管理员可访问的路由组；非管理员返回 403 而非渲染页面 */
export default function AdminRoute() {
  const { user } = useAuth();
  if (user?.role !== 'ADMIN') {
    return (
      <Result status="403" title="403" subTitle="需要管理员权限才能访问该页面。" />
    );
  }
  return <Outlet />;
}
