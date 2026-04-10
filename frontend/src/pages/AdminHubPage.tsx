import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield, Users, Server, Network, Globe, Settings,
  Activity, Cpu, Loader2, ArrowRight, Radio, Cloud,
  BarChart3, Zap, Lock, AlertTriangle,
} from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../contexts/AuthContext';

interface HubStats {
  totalUsers: number;
  nodesOnline: number;
  totalNodes: number;
  appsRunning: number;
  totalApps: number;
}

interface RecentUser {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

export default function AdminHubPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState<HubStats | null>(null);
  const [recentUsers, setRecentUsers] = useState<RecentUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [nodesRes, appsRes, usersRes] = await Promise.allSettled([
          api.get('/v1/agent/nodes'),
          api.get('/v1/scheduler/apps'),
          api.get('/users'),
        ]);

        const nodes = nodesRes.status === 'fulfilled' ? (nodesRes.value.data.data.nodes ?? []) : [];
        const apps  = appsRes.status === 'fulfilled'  ? (appsRes.value.data.data.apps   ?? []) : [];
        const users = usersRes.status === 'fulfilled' ? (usersRes.value.data.data.users  ?? []) : [];

        setStats({
          totalUsers:  users.length,
          nodesOnline: nodes.filter((n: any) => n.status === 'ONLINE').length,
          totalNodes:  nodes.length,
          appsRunning: apps.filter((a: any) => a.status === 'RUNNING').length,
          totalApps:   apps.length,
        });

        setRecentUsers(
          [...users]
            .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, 5)
        );
      } catch {
        // Non-fatal — show partial data
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const quickLinks = [
    {
      icon: Shield,
      label: 'Sentinel',
      description: 'Monitoramento de nós e benchmarks',
      to: '/sentinel',
      color: 'text-violet-400',
      bg: 'bg-violet-500/10 border-violet-500/20',
    },
    {
      icon: Cloud,
      label: 'Cloud',
      description: 'Infraestrutura e deploy de containers',
      to: '/cloud',
      color: 'text-sky-400',
      bg: 'bg-sky-500/10 border-sky-500/20',
    },
    {
      icon: Users,
      label: 'Usuários',
      description: 'Gestão de contas e permissões',
      to: '/admin/users',
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10 border-emerald-500/20',
    },
    {
      icon: Globe,
      label: 'Gateway',
      description: 'Rotas e proxy reverso dinâmico',
      to: '/gateway',
      color: 'text-amber-400',
      bg: 'bg-amber-500/10 border-amber-500/20',
    },
    {
      icon: Network,
      label: 'Apps DePIN',
      description: 'Gerenciar apps distribuídos',
      to: '/depin',
      color: 'text-accent-light',
      bg: 'bg-accent/10 border-accent/20',
    },
    {
      icon: Radio,
      label: 'Collective',
      description: 'Radar de consenso da rede',
      to: '/collective',
      color: 'text-pink-400',
      bg: 'bg-pink-500/10 border-pink-500/20',
    },
    {
      icon: BarChart3,
      label: 'Financeiro',
      description: 'Wallet, receitas e transações',
      to: '/billing',
      color: 'text-teal-400',
      bg: 'bg-teal-500/10 border-teal-500/20',
    },
    {
      icon: Settings,
      label: 'Configurações',
      description: 'Parâmetros do sistema',
      to: '/settings',
      color: 'text-text-muted',
      bg: 'bg-white/5 border-border',
    },
  ];

  const roleLabel: Record<string, { label: string; cls: string }> = {
    ADM:       { label: 'Admin',     cls: 'badge-danger' },
    TECNICO:   { label: 'Técnico',   cls: 'badge-success' },
    OBSERVADOR:{ label: 'Observer',  cls: 'badge-neutral' },
  };

  return (
    <div className="space-y-8 animate-fade-in">

      {/* ── Welcome banner ──────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-bg-card via-bg-secondary to-bg-card p-8">
        <div className="absolute inset-0 opacity-5">
          <div className="absolute -right-10 -top-10 w-64 h-64 rounded-full bg-accent blur-3xl" />
          <div className="absolute -left-10 -bottom-10 w-48 h-48 rounded-full bg-violet-500 blur-3xl" />
        </div>
        <div className="relative flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-2.5 mb-3">
              <div className="p-2 rounded-lg bg-accent/20 border border-accent/30">
                <Shield className="w-5 h-5 text-accent-light" />
              </div>
              <span className="text-[11px] font-bold text-accent-light uppercase tracking-widest">Nexus Admin Hub</span>
            </div>
            <h1 className="text-3xl font-bold text-text-primary mb-2">
              Olá, {user?.name?.split(' ')[0]}.
            </h1>
            <p className="text-text-secondary max-w-lg">
              Bem-vindo ao hub de administração da plataforma. Monitore a rede, gerencie usuários e controle toda a infraestrutura DePIN.
            </p>
          </div>
          <div className="hidden md:flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-danger/10 border border-danger/20 text-danger text-[12px] font-semibold">
              <Lock className="w-3.5 h-3.5" />
              ADM
            </div>
          </div>
        </div>
      </div>

      {/* ── Stats row ───────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="w-6 h-6 text-accent animate-spin" />
        </div>
      ) : stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { icon: Users,    label: 'Usuários',     value: stats.totalUsers,                      sub: 'cadastrados',           color: 'text-emerald-400' },
            { icon: Server,   label: 'Nós Online',   value: `${stats.nodesOnline}/${stats.totalNodes}`, sub: 'da rede ativos',     color: 'text-sky-400' },
            { icon: Network,  label: 'Apps DePIN',   value: `${stats.appsRunning}/${stats.totalApps}`, sub: 'em execução',         color: 'text-accent-light' },
            { icon: Activity, label: 'Status',       value: stats.nodesOnline > 0 ? 'Operacional' : 'Degradado', sub: 'do sistema', color: stats.nodesOnline > 0 ? 'text-success' : 'text-warning' },
          ].map(({ icon: Icon, label, value, sub, color }) => (
            <div key={label} className="rounded-xl border border-border bg-bg-card p-5">
              <div className="flex items-center gap-2 mb-3">
                <Icon className={`w-4 h-4 ${color}`} />
                <span className="text-[11px] font-bold text-text-muted uppercase tracking-widest">{label}</span>
              </div>
              <p className={`text-2xl font-bold ${color}`}>{value}</p>
              <p className="text-[11px] text-text-muted mt-1">{sub}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Quick access grid ───────────────────────────────────────────── */}
      <div>
        <h2 className="text-[11px] font-bold text-text-muted uppercase tracking-widest mb-4">Acesso Rápido</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {quickLinks.map(({ icon: Icon, label, description, to, color, bg }) => (
            <button
              key={to}
              onClick={() => navigate(to)}
              className={`flex flex-col gap-3 p-4 rounded-xl border ${bg} hover:scale-[1.02] active:scale-[0.99] transition-all text-left group`}
            >
              <div className="flex items-center justify-between">
                <Icon className={`w-5 h-5 ${color}`} />
                <ArrowRight className="w-3.5 h-3.5 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <div>
                <p className="text-[13px] font-bold text-text-primary">{label}</p>
                <p className="text-[11px] text-text-muted mt-0.5 leading-relaxed">{description}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Recent users ────────────────────────────────────────────────── */}
      {recentUsers.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[11px] font-bold text-text-muted uppercase tracking-widest">Usuários Recentes</h2>
            <button
              onClick={() => navigate('/admin/users')}
              className="flex items-center gap-1 text-[12px] text-accent-light hover:text-accent transition-colors"
            >
              Ver todos
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>
          <div className="rounded-xl border border-border bg-bg-card overflow-hidden">
            {recentUsers.map((u, i) => {
              const rl = roleLabel[u.role] ?? { label: u.role, cls: 'badge-neutral' };
              return (
                <div
                  key={u.id}
                  className={`flex items-center justify-between px-5 py-3.5 ${
                    i < recentUsers.length - 1 ? 'border-b border-border' : ''
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-bg-secondary border border-border flex items-center justify-center text-[12px] font-bold text-text-primary shrink-0">
                      {u.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-[13px] font-semibold text-text-primary">{u.name}</p>
                      <p className="text-[11px] text-text-muted">{u.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`badge ${rl.cls}`}>{rl.label}</span>
                    <span className="text-[11px] text-text-muted hidden md:block">
                      {new Date(u.createdAt).toLocaleDateString('pt-BR')}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Tenant zone notice ──────────────────────────────────────────── */}
      <div className="flex items-start gap-3 p-4 rounded-xl border border-warning/20 bg-warning/5">
        <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
        <div>
          <p className="text-[13px] font-semibold text-warning">Zona de administração</p>
          <p className="text-[12px] text-text-muted mt-0.5">
            Este hub é exclusivo para contas ADM. Contas tenant (Técnico / Observador) acessam o painel padrão em{' '}
            <button onClick={() => navigate('/dashboard')} className="text-accent-light hover:underline">
              /dashboard
            </button>.
          </p>
        </div>
      </div>

    </div>
  );
}
