import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { LayoutDashboard, Users, LogOut, Shield, Settings, Globe, Cloud, FolderGit2 } from 'lucide-react';

export default function Navbar() {
  const { user, logout, hasRole } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
      isActive
        ? 'bg-accent/10 text-accent-light border border-accent/20'
        : 'text-text-secondary hover:text-text-primary hover:bg-bg-card-hover'
    }`;

  return (
    <header className="fixed top-0 left-0 right-0 h-14 z-50 flex items-center border-b border-border bg-bg-secondary">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 h-full border-r border-border shrink-0">
        <img src="/favicon.svg" alt="Nexus" className="w-7 h-7 rounded-md object-cover" />
        <span className="text-sm font-bold text-text-primary tracking-widest">NEXUS</span>
      </div>

      {/* Navigation */}
      <nav className="flex items-center gap-1 px-4 flex-1">
        <NavLink to="/dashboard" className={linkClass}>
          <LayoutDashboard className="w-4 h-4" />
          Painel
        </NavLink>
        <NavLink to="/projects" className={linkClass}>
          <FolderGit2 className="w-4 h-4" />
          Projetos
        </NavLink>
        {(hasRole('ADM') || hasRole('TECNICO')) && (
          <NavLink to="/gateway" className={linkClass}>
            <Globe className="w-4 h-4" />
            API Gateway
          </NavLink>
        )}
        {hasRole('ADM') && (
          <NavLink to="/cloud" className={linkClass}>
            <Cloud className="w-4 h-4" />
            Cloud
          </NavLink>
        )}
        {hasRole('ADM') && (
          <NavLink to="/admin/users" className={linkClass}>
            <Users className="w-4 h-4" />
            Usuários
          </NavLink>
        )}
        {hasRole('ADM') && (
          <NavLink to="/settings" className={linkClass}>
            <Settings className="w-4 h-4" />
            Configurações
          </NavLink>
        )}
      </nav>

      {/* User */}
      <div className="flex items-center gap-3 px-4 h-full border-l border-border">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-bg-card border border-border flex items-center justify-center text-xs font-bold text-text-primary shrink-0">
            {user?.name?.charAt(0).toUpperCase()}
          </div>
          <div className="hidden md:block">
            <p className="text-sm font-semibold text-text-primary leading-none">{user?.name}</p>
            <div className="flex items-center gap-1 mt-0.5">
              <Shield className="w-3 h-3 text-accent-light" />
              <span className="text-[11px] text-accent-light font-medium">{user?.role}</span>
            </div>
          </div>
        </div>
        <button
          onClick={handleLogout}
          title="Encerrar Sessão"
          className="p-1.5 rounded-md text-text-muted hover:text-danger hover:bg-danger/10 transition-colors"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
