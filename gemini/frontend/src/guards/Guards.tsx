import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-primary">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

export function RoleGuard({
  children,
  allowedRoles,
  fallback = null,
}: {
  children: React.ReactNode;
  allowedRoles: string[];
  fallback?: React.ReactNode;
}) {
  const { hasRole } = useAuth();

  if (!hasRole(...allowedRoles)) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
