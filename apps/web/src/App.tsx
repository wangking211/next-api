import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Spin } from 'antd';
import { AuthProvider } from './auth/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import RoleRoute from './components/RoleRoute';
import AppLayout from './components/AppLayout';

const LandingPage = lazy(() => import('./pages/landing/LandingPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const KeysPage = lazy(() => import('./pages/KeysPage'));
const ChannelsPage = lazy(() => import('./pages/ChannelsPage'));
const AvailableModelsPage = lazy(() => import('./pages/AvailableModelsPage'));
const ModelsPage = lazy(() => import('./pages/ModelsPage'));
const LogsPage = lazy(() => import('./pages/LogsPage'));
const UsageStatsPage = lazy(() => import('./pages/UsageStatsPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const AgentPage = lazy(() => import('./pages/AgentPage'));
const AdminUsersPage = lazy(() => import('./pages/AdminUsersPage'));
const AdminRedeemPage = lazy(() => import('./pages/AdminRedeemPage'));
const AuditLogsPage = lazy(() => import('./pages/AuditLogsPage'));
const AdminWithdrawalsPage = lazy(() => import('./pages/AdminWithdrawalsPage'));
const GroupsPage = lazy(() => import('./pages/GroupsPage'));

function PageFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
      <Spin size="large" />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ErrorBoundary>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            {/* 公开路由 */}
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />

            <Route element={<ProtectedRoute />}>
              <Route element={<AppLayout />}>
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/keys" element={<KeysPage />} />
                <Route path="/channels" element={<ChannelsPage />} />
                <Route path="/available-models" element={<AvailableModelsPage />} />
                <Route path="/models" element={<ModelsPage />} />
                <Route path="/logs" element={<LogsPage />} />
                <Route path="/usage-stats" element={<UsageStatsPage />} />
                <Route path="/billing" element={<BillingPage />} />
                {/* 菜单只对代理/管理员展示，但直达 URL 也必须拦：后端 /api/agent 全线 403 */}
                <Route element={<RoleRoute roles={['AGENT', 'ADMIN']} />}>
                  <Route path="/agent" element={<AgentPage />} />
                </Route>
                <Route element={<AdminRoute />}>
                  <Route path="/users" element={<AdminUsersPage />} />
                  <Route path="/groups" element={<GroupsPage />} />
                  <Route path="/redeem-codes" element={<AdminRedeemPage />} />
                  <Route path="/audit-logs" element={<AuditLogsPage />} />
                  <Route path="/withdrawals" element={<AdminWithdrawalsPage />} />
                </Route>
              </Route>
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </AuthProvider>
  );
}
