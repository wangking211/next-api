import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import AppLayout from './components/AppLayout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import KeysPage from './pages/KeysPage';
import ChannelsPage from './pages/ChannelsPage';
import AvailableModelsPage from './pages/AvailableModelsPage';
import ModelsPage from './pages/ModelsPage';
import LogsPage from './pages/LogsPage';
import BillingPage from './pages/BillingPage';
import AdminUsersPage from './pages/AdminUsersPage';
import AdminRedeemPage from './pages/AdminRedeemPage';
import AuditLogsPage from './pages/AuditLogsPage';

export default function App() {
  return (
    <AuthProvider>
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
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/users" element={<AdminUsersPage />} />
            <Route path="/redeem-codes" element={<AdminRedeemPage />} />
            <Route path="/audit-logs" element={<AuditLogsPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
