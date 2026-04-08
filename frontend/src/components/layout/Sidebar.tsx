import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  LayoutDashboard, Users, LogOut, Shield, Settings,
  Globe, Cloud, FolderGit2, Network, Cpu, ChevronDown,
} from 'lucide-react';
import { useState } from 'react';

export default function Navbar() {
  const { user, logout, hasRole } = useAuth();
  const navigate = useNavigate();
  const [depinOpen, setDepinOpen] = useState(false);

  const handleLogout = () => { logout(); navigate('/login'); };

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-all duration-150 ${
      isActive
        ? 'font-semibold text-text-primary bg-white/5'
        : 'font-medium text-text-secondary hover:text-text-primary hover:bg-white/[0.03]'
    }`;

  return (
    <header className="glass-nav fixed top-0 left-0 right-0 h-13 z-50 flex items-center">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 h-full border-r border-white/[0.06] shrink-0">
        <img src="/favicon.svg" alt="Nexus" className="w-6 h-6 rounded-md object-cover" />
        <span className="text-[13px] font-bold text-text-primary tracking-[0.15em]">NEXUS</span>
      </div>

      {/* Navigation */}
      <nav className="flex items-center gap-0.5 px-3 flex-1">
        <NavLink to="/dashboard" className={linkClass}>
          <LayoutDashboard className="w-[15px] h-[15px] shrink-0" />
          Painel
        </NavLink>

        <NavLink to="/projects" className={linkClass}>
          <FolderGit2 className="w-[15px] h-[15px] shrink-0" />
          Projetos
        </NavLink>

        {/* DePIN dropdown */}
        <div className="relative">
          <button
            onClick={() => setDepinOpen(v => !v)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150
              ${depinOpen
                ? 'text-text-primary bg-white/5 font-semibold'
                : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.03]'
              }`}
          >
            <Network className="w-[15px] h-[15px] shrink-0" />
            DePIN
            <ChevronDown
              className={`w-3.5 h-3.5 transition-transform duration-200 ${depinOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {depinOpen && (
            <div className="glass-elevated absolute top-full left-0 mt-2 w-52 py-1.5 z-50 animate-scale-in">
              <NavLink
                to="/depin"
                onClick={() => setDepinOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3.5 py-2 text-sm transition-colors ${
                    isActive
                      ? 'font-semibold text-text-primary'
                      : 'font-medium text-text-secondary hover:text-text-primary'
                  }`
                }
              >
                <Network className="w-4 h-4 shrink-0" />
                Apps DePIN
              </NavLink>
              <NavLink
                to="/provider"
                onClick={() => setDepinOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3.5 py-2 text-sm transition-colors ${
                    isActive
                      ? 'font-semibold text-text-primary'
                      : 'font-medium text-text-secondary hover:text-text-primary'
                  }`
                }
              >
                <Cpu className="w-4 h-4 shrink-0" />
                Provedor de Hardware
              </NavLink>
              <NavLink
                to="/billing"
                onClick={() => setDepinOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3.5 py-2 text-sm transition-colors ${
                    isActive
                      ? 'font-semibold text-text-primary'
                      : 'font-medium text-text-secondary hover:text-text-primary'
                  }`
                }
              >
                <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
                </svg>
                Financeiro
              </NavLink>
            </div>
          )}
        </div>

        {(hasRole('ADM') || hasRole('TECNICO')) && (
          <NavLink to="/gateway" className={linkClass}>
            <Globe className="w-[15px] h-[15px] shrink-0" />
            Gateway
          </NavLink>
        )}

        {hasRole('ADM') && (
          <NavLink to="/cloud" className={linkClass}>
            <Cloud className="w-[15px] h-[15px] shrink-0" />
            Cloud
          </NavLink>
        )}

        {hasRole('ADM') && (
          <NavLink to="/admin/users" className={linkClass}>
            <Users className="w-[15px] h-[15px] shrink-0" />
            Usuários
          </NavLink>
        )}

        {hasRole('ADM') && (
          <NavLink to="/settings" className={linkClass}>
            <Settings className="w-[15px] h-[15px] shrink-0" />
            Config
          </NavLink>
        )}
      </nav>

      {/* User */}
      <div className="flex items-center gap-3 px-4 h-full border-l border-white/[0.06]">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-bg-card border border-border flex items-center justify-center text-[11px] font-bold text-text-primary shrink-0">
            {user?.name?.charAt(0).toUpperCase()}
          </div>
          <div className="hidden md:block">
            <p className="text-[13px] font-semibold text-text-primary leading-none">{user?.name}</p>
            <div className="flex items-center gap-1 mt-0.5">
              <Shield className="w-3 h-3 text-accent-light" />
              <span className="text-[11px] text-accent-light font-medium">{user?.role}</span>
            </div>
          </div>
        </div>
        <button
          onClick={handleLogout}
          title="Encerrar Sessão"
          className="p-1.5 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 transition-colors"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
