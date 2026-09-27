import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Spin } from 'antd';
import { AuthProvider } from './auth/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import AppLayout from './components/AppLayout';

const LoginPage = lazy(() => import('./pages/LoginPage'));
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
            <Route path="/login" element={<LoginPage />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<AppLayout />}>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/keys" element={<KeysPage />} />
                <Route path="/channels" element={<ChannelsPage />} />
                <Route path="/available-models" element={<AvailableModelsPage />} />
                <Route path="/models" element={<ModelsPage />} />
                <Route path="/logs" element={<LogsPage />} />
                <Route path="/usage-stats" element={<UsageStatsPage />} />
                <Route path="/billing" element={<BillingPage />} />
                <Route path="/agent" element={<AgentPage />} />
                <Route element={<AdminRoute />}>
                  <Route path="/users" element={<AdminUsersPage />} />
                  <Route path="/redeem-codes" element={<AdminRedeemPage />} />
                  <Route path="/audit-logs" element={<AuditLogsPage />} />
                </Route>
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </AuthProvider>
  );
}
