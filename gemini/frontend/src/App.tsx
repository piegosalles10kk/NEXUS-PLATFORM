import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedRoute, RoleGuard } from './guards/Guards';
import AppLayout from './components/layout/AppLayout';
import LoginPage from './pages/LoginPage';
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

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />

          {/* Protected routes */}
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <AppLayout>
                  <DashboardPage />
                </AppLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/projects"
            element={
              <ProtectedRoute>
                <AppLayout>
                  <ProjectsPage />
                </AppLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/project/:id"
            element={
              <ProtectedRoute>
                <AppLayout>
                  <ProjectPage />
                </AppLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/users"
            element={
              <ProtectedRoute>
                <RoleGuard allowedRoles={['ADM']} fallback={<Navigate to="/dashboard" replace />}>
                  <AppLayout>
                    <AdminUsersPage />
                  </AppLayout>
                </RoleGuard>
              </ProtectedRoute>
            }
          />

          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <RoleGuard allowedRoles={['ADM']} fallback={<Navigate to="/dashboard" replace />}>
                  <AppLayout>
                    <SettingsPage />
                  </AppLayout>
                </RoleGuard>
              </ProtectedRoute>
            }
          />

          <Route
            path="/gateway"
            element={
              <ProtectedRoute>
                <RoleGuard allowedRoles={['ADM', 'TECNICO']} fallback={<Navigate to="/dashboard" replace />}>
                  <AppLayout>
                    <GatewayPage />
                  </AppLayout>
                </RoleGuard>
              </ProtectedRoute>
            }
          />

          <Route
            path="/cloud"
            element={
              <ProtectedRoute>
                <RoleGuard allowedRoles={['ADM']} fallback={<Navigate to="/dashboard" replace />}>
                  <AppLayout>
                    <CloudPage />
                  </AppLayout>
                </RoleGuard>
              </ProtectedRoute>
            }
          />
          <Route
            path="/cloud/servers/:id"
            element={
              <ProtectedRoute>
                <RoleGuard allowedRoles={['ADM']} fallback={<Navigate to="/dashboard" replace />}>
                  <AppLayout>
                    <ServerDetailsPage />
                  </AppLayout>
                </RoleGuard>
              </ProtectedRoute>
            }
          />

          {/* Default redirect */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
