import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ProtectedRoute, RoleGuard } from './guards/Guards';
import AppLayout from './components/layout/AppLayout';

// Existing pages
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import DashboardPage from './pages/DashboardPage';
import ProjectPage from './pages/ProjectPage';
import AdminUsersPage from './pages/AdminUsersPage';
import SettingsPage from './pages/SettingsPage';
import GatewayPage from './pages/GatewayPage';
import CloudPage from './pages/CloudPage';
import ServerDetailsPage from './pages/ServerDetailsPage';
import ProjectsPage from './pages/ProjectsPage';

// New DePIN / Billing / Provider pages
import DePINAppsPage from './pages/DePINAppsPage';
import DePINClusterView from './pages/DePINClusterView';
import BillingPage from './pages/BillingPage';
import ProviderPage from './pages/ProviderPage';
import SonarRadarPage from './pages/SonarRadarPage';
import SentinelPage from './pages/SentinelPage';
import AdminHubPage from './pages/AdminHubPage';

// Redireciona para o hub certo baseado no role do usuário logado
function RootRedirect() {
  const { user, isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Navigate to={user?.role === 'ADM' ? '/admin' : '/dashboard'} replace />;
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* ── Public ─────────────────────────────────────────────────── */}
          <Route path="/login"           element={<LoginPage />} />
          <Route path="/register"        element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password"  element={<ResetPasswordPage />} />

          {/* ── Admin Hub (ADM only) ───────────────────────────────────── */}
          <Route path="/admin" element={
            <ProtectedRoute>
              <RoleGuard allowedRoles={['ADM']} fallback={<Navigate to="/dashboard" replace />}>
                <AppLayout><AdminHubPage /></AppLayout>
              </RoleGuard>
            </ProtectedRoute>
          } />

          {/* ── Protected — CI/CD ──────────────────────────────────────── */}
          <Route path="/dashboard" element={
            <ProtectedRoute><AppLayout><DashboardPage /></AppLayout></ProtectedRoute>
          } />
          <Route path="/projects" element={
            <ProtectedRoute><AppLayout><ProjectsPage /></AppLayout></ProtectedRoute>
          } />
          <Route path="/project/:id" element={
            <ProtectedRoute><AppLayout><ProjectPage /></AppLayout></ProtectedRoute>
          } />

          {/* ── Protected — DePIN ──────────────────────────────────────── */}
          <Route path="/depin" element={
            <ProtectedRoute><AppLayout><DePINAppsPage /></AppLayout></ProtectedRoute>
          } />
          <Route path="/depin/:id" element={
            <ProtectedRoute><AppLayout><DePINClusterView /></AppLayout></ProtectedRoute>
          } />
          <Route path="/collective" element={
            <ProtectedRoute><AppLayout><SonarRadarPage /></AppLayout></ProtectedRoute>
          } />

          {/* ── Protected — Financeiro ─────────────────────────────────── */}
          <Route path="/billing" element={
            <ProtectedRoute><AppLayout><BillingPage /></AppLayout></ProtectedRoute>
          } />

          {/* ── Protected — Provedor de Hardware ──────────────────────── */}
          <Route path="/provider" element={
            <ProtectedRoute><AppLayout><ProviderPage /></AppLayout></ProtectedRoute>
          } />

          {/* ── Protected — ADM / TECNICO ──────────────────────────────── */}
          <Route path="/gateway" element={
            <ProtectedRoute>
              <RoleGuard allowedRoles={['ADM', 'TECNICO']} fallback={<Navigate to="/dashboard" replace />}>
                <AppLayout><GatewayPage /></AppLayout>
              </RoleGuard>
            </ProtectedRoute>
          } />

          {/* ── Protected — ADM only ────────────────────────────────────── */}
          <Route path="/cloud" element={
            <ProtectedRoute>
              <RoleGuard allowedRoles={['ADM']} fallback={<Navigate to="/dashboard" replace />}>
                <AppLayout><CloudPage /></AppLayout>
              </RoleGuard>
            </ProtectedRoute>
          } />
          <Route path="/cloud/servers/:id" element={
            <ProtectedRoute>
              <RoleGuard allowedRoles={['ADM']} fallback={<Navigate to="/dashboard" replace />}>
                <AppLayout><ServerDetailsPage /></AppLayout>
              </RoleGuard>
            </ProtectedRoute>
          } />
          <Route path="/admin/users" element={
            <ProtectedRoute>
              <RoleGuard allowedRoles={['ADM']} fallback={<Navigate to="/dashboard" replace />}>
                <AppLayout><AdminUsersPage /></AppLayout>
              </RoleGuard>
            </ProtectedRoute>
          } />
          <Route path="/settings" element={
            <ProtectedRoute>
              <RoleGuard allowedRoles={['ADM']} fallback={<Navigate to="/dashboard" replace />}>
                <AppLayout><SettingsPage /></AppLayout>
              </RoleGuard>
            </ProtectedRoute>
          } />

          {/* ── Protected — Sentinel backoffice (ADM only) ─────────────── */}
          <Route path="/sentinel" element={
            <ProtectedRoute>
              <RoleGuard allowedRoles={['ADM']} fallback={<Navigate to="/dashboard" replace />}>
                <SentinelPage />
              </RoleGuard>
            </ProtectedRoute>
          } />

          {/* ── Default redirect ────────────────────────────────────────── */}
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
