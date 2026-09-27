import { Spin } from 'antd';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { loginPathWithRedirect } from '../api/client';

export default function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 200 }}>
        <Spin size="large" />
      </div>
    );
  }
  if (!user) {
    // 记录原始目标，登录成功后原路返回
    return <Navigate to={loginPathWithRedirect(location.pathname, location.search)} replace />;
  }
  return <Outlet />;
}
