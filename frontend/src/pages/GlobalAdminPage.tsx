/**
 * GlobalAdminPage.tsx
 *
 * Painel de administração global da plataforma Nexus.
 * Acesso exclusivo para usuários com role ADM.
 *
 * Abas:
 *  1. Visão Geral   — stats, saúde da rede, acesso rápido
 *  2. Tenants       — gestão de organizações + geração de convites
 *  3. Usuários      — gestão de contas e permissões
 *  4. Rede          — nós da malha + teste de conectividade
 *  5. Auditoria     — trilha de auditoria LGPD
 */

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Shield, Users, Server, Network, Globe, Settings,
  Activity, Loader2, ArrowRight, Cloud, BarChart3,
  AlertTriangle, Building2, Ticket, Ban, CheckCircle2,
  RefreshCw, Copy, Trash2, Plus, Edit, X, Check,
  AlertCircle, Cpu, Wifi, WifiOff, Lock, Zap,
  Eye, Filter, ChevronDown, Radio, Database,
} from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../contexts/AuthContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlatformStats {
  totalUsers: number;
  totalTenants: number;
  nodesOnline: number;
  totalNodes: number;
  appsRunning: number;
  totalApps: number;
}

interface Tenant {
  id: string;
  name: string;
  document?: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
  creditUsd: number;
  createdAt: string;
  _count: { users: number; nodes: number; depinApps: number };
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: 'ADM' | 'TECNICO' | 'OBSERVADOR';
  isActive?: boolean;
  createdAt: string;
}

interface NodeRow {
  id: string;
  name: string;
  status: 'ONLINE' | 'OFFLINE' | 'UPDATING';
  os: string;
  arch: string;
  ipAddress?: string;
  country?: string;
  city?: string;
  cpuCores: number;
  ramMb: number;
  infraType: string;
  benchmarkTier?: string;
  tenantId?: string;
  tenant?: { name: string };
  lastPing: string;
}

interface InviteCode {
  id: string;
  code: string;
  genesisUsd: number;
  usedById?: string;
  usedAt?: string;
  createdAt: string;
  createdBy: { name: string; email: string };
  usedBy?: { name: string; email: string } | null;
}

interface AuditEntry {
  id: string;
  action: string;
  targetId?: string;
  ipAddress?: string;
  payload?: any;
  createdAt: string;
  actor?: { name: string; email: string } | null;
}

interface MeshResult {
  totalNodes: number;
  responded: number;
  durationMs: number;
  results: { nodeId: string; responded: boolean; rttMs: number }[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview',  label: 'Visão Geral',  icon: BarChart3 },
  { id: 'tenants',   label: 'Tenants',       icon: Building2 },
  { id: 'users',     label: 'Usuários',      icon: Users },
  { id: 'network',   label: 'Rede',          icon: Network },
  { id: 'audit',     label: 'Auditoria',     icon: Eye },
] as const;

type TabId = (typeof TABS)[number]['id'];

const tenantStatusCfg: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
  ACTIVE:    { label: 'Ativo',     cls: 'text-success bg-success/10 border-success/20',  icon: CheckCircle2 },
  SUSPENDED: { label: 'Suspenso',  cls: 'text-warning bg-warning/10 border-warning/20',  icon: AlertTriangle },
  BANNED:    { label: 'Banido',    cls: 'text-danger  bg-danger/10  border-danger/20',   icon: Ban },
};

const roleCfg: Record<string, { label: string; cls: string }> = {
  ADM:        { label: 'ADM',        cls: 'text-accent-light bg-accent/10 border-accent/20' },
  TECNICO:    { label: 'Técnico',    cls: 'text-success bg-success/10 border-success/20' },
  OBSERVADOR: { label: 'Observador', cls: 'text-warning bg-warning/10 border-warning/20' },
};

const nodeTierCfg: Record<string, string> = {
  PLATINUM: 'text-violet-400',
  GOLD:     'text-yellow-400',
  SILVER:   'text-slate-300',
  BRONZE:   'text-amber-600',
};

const auditActionCfg: Record<string, { label: string; cls: string }> = {
  BAN:            { label: 'Ban',            cls: 'text-danger' },
  UNBAN:          { label: 'Unban',          cls: 'text-success' },
  MINT:           { label: 'Mint',           cls: 'text-accent-light' },
  BURN:           { label: 'Burn',           cls: 'text-warning' },
  DELETE_USER:    { label: 'Delete User',    cls: 'text-danger' },
  HALT:           { label: 'Emergency Halt', cls: 'text-danger' },
  CREATE_INVITE:  { label: 'Invite',         cls: 'text-sky-400' },
  NODE_TERMINATE: { label: 'Node Kill',      cls: 'text-warning' },
  APP_REMOVE:     { label: 'App Remove',     cls: 'text-warning' },
  BENCHMARK:      { label: 'Benchmark',      cls: 'text-violet-400' },
  STRESS_TEST:    { label: 'Stress Test',    cls: 'text-pink-400' },
};

// ── Main Component ─────────────────────────────────────────────────────────────

export default function GlobalAdminPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  return (
    <div className="space-y-5 animate-fade-in">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-bg-card via-bg-secondary to-bg-card p-6">
        <div className="absolute inset-0 opacity-5 pointer-events-none">
          <div className="absolute -right-10 -top-10 w-64 h-64 rounded-full bg-accent blur-3xl" />
          <div className="absolute -left-10 -bottom-10 w-48 h-48 rounded-full bg-violet-500 blur-3xl" />
        </div>
        <div className="relative flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-accent/20 border border-accent/30">
              <Shield className="w-5 h-5 text-accent-light" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[10px] font-bold text-accent-light uppercase tracking-widest">
                  Admin Global · Nexus Platform
                </span>
              </div>
              <h1 className="text-xl font-bold text-text-primary">
                Olá, {user?.name?.split(' ')[0]}
              </h1>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-danger/10 border border-danger/20 text-danger text-[11px] font-bold">
              <Lock className="w-3 h-3" />
              GLOBAL ADM
            </div>
          </div>
        </div>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-[13px] font-semibold border-b-2 transition-all -mb-px ${
              activeTab === id
                ? 'border-accent text-accent-light'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* ── Tab Content ─────────────────────────────────────────────────────── */}
      {activeTab === 'overview'  && <OverviewTab navigate={navigate} />}
      {activeTab === 'tenants'   && <TenantsTab />}
      {activeTab === 'users'     && <UsersTab />}
      {activeTab === 'network'   && <NetworkTab />}
      {activeTab === 'audit'     && <AuditTab />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: VISÃO GERAL
// ══════════════════════════════════════════════════════════════════════════════

function OverviewTab({ navigate }: { navigate: (to: string) => void }) {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [nodesRes, appsRes, usersRes, tenantsRes] = await Promise.allSettled([
          api.get('/v1/agent/nodes'),
          api.get('/v1/scheduler/apps'),
          api.get('/users'),
          api.get('/v1/admin/tenants'),
        ]);
        const nodes   = nodesRes.status   === 'fulfilled' ? (nodesRes.value.data.data.nodes   ?? []) : [];
        const apps    = appsRes.status    === 'fulfilled' ? (appsRes.value.data.data.apps     ?? []) : [];
        const users   = usersRes.status   === 'fulfilled' ? (usersRes.value.data.data.users   ?? []) : [];
        const tenants = tenantsRes.status === 'fulfilled' ? (tenantsRes.value.data.data.tenants ?? []) : [];
        setStats({
          totalUsers:   users.length,
          totalTenants: tenants.length,
          nodesOnline:  nodes.filter((n: any) => n.status === 'ONLINE').length,
          totalNodes:   nodes.length,
          appsRunning:  apps.filter((a: any) => a.status === 'RUNNING').length,
          totalApps:    apps.length,
        });
      } finally { setLoading(false); }
    };
    load();
  }, []);

  const quickLinks = [
    { icon: Shield, label: 'Sentinel',       desc: 'Benchmarks e monitoramento de nós',   to: '/sentinel',       color: 'text-violet-400', bg: 'bg-violet-500/10 border-violet-500/20' },
    { icon: Cloud,  label: 'Cloud',          desc: 'Infraestrutura e containers',          to: '/cloud',          color: 'text-sky-400',    bg: 'bg-sky-500/10 border-sky-500/20' },
    { icon: Globe,  label: 'Gateway',        desc: 'Rotas e proxy reverso',                to: '/gateway',        color: 'text-amber-400',  bg: 'bg-amber-500/10 border-amber-500/20' },
    { icon: Network,label: 'Apps DePIN',     desc: 'Apps distribuídos na malha',           to: '/depin',          color: 'text-accent-light',bg: 'bg-accent/10 border-accent/20' },
    { icon: Radio,  label: 'Collective',     desc: 'Radar de consenso da rede',            to: '/collective',     color: 'text-pink-400',   bg: 'bg-pink-500/10 border-pink-500/20' },
    { icon: BarChart3,label:'Financeiro',    desc: 'Wallet, receitas e transações',        to: '/billing',        color: 'text-teal-400',   bg: 'bg-teal-500/10 border-teal-500/20' },
    { icon: Settings,label:'Configurações',  desc: 'Parâmetros do sistema',                to: '/settings',       color: 'text-text-muted', bg: 'bg-white/5 border-border' },
    { icon: Database,label:'Projetos CI/CD', desc: 'Deploy e integração contínua',         to: '/projects',       color: 'text-emerald-400',bg: 'bg-emerald-500/10 border-emerald-500/20' },
  ];

  if (loading) return (
    <div className="flex justify-center py-16">
      <Loader2 className="w-6 h-6 text-accent animate-spin" />
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { icon: Users,    label: 'Usuários',    value: stats?.totalUsers ?? '–',                            sub: 'cadastrados',       color: 'text-emerald-400' },
          { icon: Building2,label: 'Tenants',     value: stats?.totalTenants ?? '–',                          sub: 'organizações',      color: 'text-sky-400' },
          { icon: Server,   label: 'Nós Online',  value: `${stats?.nodesOnline ?? 0}/${stats?.totalNodes ?? 0}`, sub: 'conectados',     color: 'text-violet-400' },
          { icon: Network,  label: 'Apps DePIN',  value: `${stats?.appsRunning ?? 0}/${stats?.totalApps ?? 0}`,  sub: 'em execução',    color: 'text-accent-light' },
          { icon: Zap,      label: 'Uptime',      value: stats && stats.nodesOnline > 0 ? '✓' : '⚠',          sub: 'status da rede',   color: stats && stats.nodesOnline > 0 ? 'text-success' : 'text-warning' },
          { icon: Activity, label: 'Sistema',     value: 'Online',                                            sub: 'backend operacional', color: 'text-success' },
        ].map(({ icon: Icon, label, value, sub, color }) => (
          <div key={label} className="rounded-xl border border-border bg-bg-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <Icon className={`w-3.5 h-3.5 ${color}`} />
              <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{label}</span>
            </div>
            <p className={`text-xl font-bold ${color}`}>{value}</p>
            <p className="text-[10px] text-text-muted mt-0.5">{sub}</p>
          </div>
        ))}
      </div>

      {/* Quick Links */}
      <div>
        <h2 className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-3">Acesso Rápido</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {quickLinks.map(({ icon: Icon, label, desc, to, color, bg }) => (
            <button
              key={to}
              onClick={() => navigate(to)}
              className={`flex flex-col gap-2.5 p-4 rounded-xl border ${bg} hover:scale-[1.02] active:scale-[0.98] transition-all text-left group`}
            >
              <div className="flex items-center justify-between">
                <Icon className={`w-4 h-4 ${color}`} />
                <ArrowRight className="w-3 h-3 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <div>
                <p className="text-[12px] font-bold text-text-primary">{label}</p>
                <p className="text-[10px] text-text-muted mt-0.5 leading-relaxed">{desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Notice */}
      <div className="flex items-start gap-3 p-4 rounded-xl border border-warning/20 bg-warning/5">
        <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
        <p className="text-[12px] text-text-muted">
          <span className="text-warning font-semibold">Zona de administração global.</span>{' '}
          Tenants (Técnico / Observador) acessam o painel padrão em{' '}
          <button onClick={() => navigate('/dashboard')} className="text-accent-light hover:underline">/dashboard</button>.
        </p>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: TENANTS
// ══════════════════════════════════════════════════════════════════════════════

function TenantsTab() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateTenant, setShowCreateTenant] = useState(false);
  const [showInvites, setShowInvites] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [tRes, iRes] = await Promise.allSettled([
        api.get('/v1/admin/tenants'),
        api.get('/v1/admin/invite-codes'),
      ]);
      if (tRes.status === 'fulfilled') setTenants(tRes.value.data.data.tenants ?? []);
      if (iRes.status === 'fulfilled') setInvites(iRes.value.data.data.codes ?? []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const tenantAction = async (id: string, action: 'ban' | 'unban' | 'suspend') => {
    setActionLoading(id + action);
    try {
      await api.post(`/v1/admin/tenants/${id}/${action}`);
      await load();
    } catch (e: any) {
      setError(e.response?.data?.message || 'Falha na operação');
    } finally { setActionLoading(null); }
  };

  const generateInvite = async (genesisUsd = 50) => {
    try {
      await api.post('/v1/admin/invite-codes', { genesisUsd });
      await load();
    } catch (e: any) {
      setError(e.response?.data?.message || 'Falha ao gerar convite');
    }
  };

  const revokeInvite = async (id: string) => {
    if (!confirm('Revogar este código de convite?')) return;
    try {
      await api.delete(`/v1/admin/invite-codes/${id}`);
      await load();
    } catch (e: any) {
      setError(e.response?.data?.message || 'Falha ao revogar convite');
    }
  };

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  };

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-accent animate-spin" /></div>;

  const pendingInvites = invites.filter(i => !i.usedById);
  const usedInvites    = invites.filter(i => i.usedById);

  return (
    <div className="space-y-6">
      {error && <ErrorBar msg={error} onClose={() => setError('')} />}

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-text-primary">Gestão de Tenants</h2>
          <p className="text-[12px] text-text-muted mt-0.5">{tenants.length} organização{tenants.length !== 1 ? 's' : ''} na plataforma</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowInvites(v => !v)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-text-secondary hover:text-text-primary text-[12px] font-semibold transition-colors"
          >
            <Ticket className="w-3.5 h-3.5" />
            Convites
            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-accent/20 text-accent-light text-[10px] font-bold">{pendingInvites.length}</span>
          </button>
          <button
            onClick={() => setShowCreateTenant(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent hover:bg-accent-light text-white text-[12px] font-semibold transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Novo Tenant
          </button>
        </div>
      </div>

      {/* ── Invite Codes Panel ── */}
      {showInvites && (
        <div className="rounded-xl border border-border bg-bg-card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-bg-secondary">
            <div className="flex items-center gap-2">
              <Ticket className="w-4 h-4 text-sky-400" />
              <span className="text-[12px] font-bold text-text-primary">Códigos de Convite</span>
              <span className="text-[11px] text-text-muted">— Testnet Onboarding</span>
            </div>
            <button
              onClick={() => generateInvite(50)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400 hover:bg-sky-500/20 text-[11px] font-bold transition-colors"
            >
              <Plus className="w-3 h-3" />
              Gerar Convite (+$50)
            </button>
          </div>

          {/* Pending invites */}
          {pendingInvites.length > 0 ? (
            <div>
              <div className="px-5 py-2 bg-bg-secondary border-b border-border">
                <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Disponíveis ({pendingInvites.length})</span>
              </div>
              {pendingInvites.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between px-5 py-3 border-b border-border last:border-0">
                  <div className="flex items-center gap-3">
                    <div className="font-mono text-[13px] font-bold text-accent-light bg-accent/10 px-2.5 py-1 rounded-lg border border-accent/20">
                      {inv.code}
                    </div>
                    <div className="text-[11px] text-text-muted">
                      ${inv.genesisUsd} crédito · por {inv.createdBy.name}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-text-muted">
                      {new Date(inv.createdAt).toLocaleDateString('pt-BR')}
                    </span>
                    <button
                      onClick={() => copyCode(inv.code)}
                      className="p-1.5 rounded-md text-text-muted hover:text-accent-light hover:bg-accent/8 transition-colors"
                      title="Copiar código"
                    >
                      {copied === inv.code ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => revokeInvite(inv.id)}
                      className="p-1.5 rounded-md text-text-muted hover:text-danger hover:bg-danger/8 transition-colors"
                      title="Revogar convite"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-5 py-4 text-center text-[12px] text-text-muted">
              Nenhum convite disponível. Gere um novo acima.
            </div>
          )}

          {/* Used invites */}
          {usedInvites.length > 0 && (
            <>
              <div className="px-5 py-2 bg-bg-secondary border-y border-border">
                <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Utilizados ({usedInvites.length})</span>
              </div>
              {usedInvites.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between px-5 py-3 border-b border-border last:border-0 opacity-60">
                  <div className="flex items-center gap-3">
                    <div className="font-mono text-[13px] font-semibold text-text-muted bg-bg-secondary px-2.5 py-1 rounded-lg border border-border line-through">
                      {inv.code}
                    </div>
                    <div className="text-[11px] text-text-muted">
                      usado por <span className="text-text-secondary">{inv.usedBy?.name ?? '—'}</span>
                    </div>
                  </div>
                  <span className="text-[10px] text-text-muted">
                    {inv.usedAt ? new Date(inv.usedAt).toLocaleDateString('pt-BR') : '—'}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* ── Tenants Table ── */}
      {tenants.length === 0 ? (
        <EmptyState icon={Building2} title="Nenhum tenant cadastrado" desc="Crie o primeiro tenant para organizar usuários e recursos." />
      ) : (
        <div className="rounded-xl border border-border bg-bg-card overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border bg-bg-secondary">
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Organização</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Status</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider text-center">Usuários</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider text-center">Nós</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider text-center">Apps</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider text-right">Créditos</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => {
                const sc = tenantStatusCfg[t.status] ?? tenantStatusCfg.ACTIVE;
                const StatusIcon = sc.icon;
                return (
                  <tr key={t.id} className="border-b border-border last:border-0 hover:bg-bg-card-hover transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-bg-secondary border border-border flex items-center justify-center text-[12px] font-bold text-text-primary shrink-0">
                          {t.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-[13px] font-semibold text-text-primary">{t.name}</p>
                          {t.document && <p className="text-[10px] text-text-muted">{t.document}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-semibold ${sc.cls}`}>
                        <StatusIcon className="w-3 h-3" />
                        {sc.label}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-center text-[13px] font-semibold text-text-primary">{t._count.users}</td>
                    <td className="py-3.5 px-4 text-center text-[13px] font-semibold text-text-primary">{t._count.nodes}</td>
                    <td className="py-3.5 px-4 text-center text-[13px] font-semibold text-text-primary">{t._count.depinApps}</td>
                    <td className="py-3.5 px-4 text-right text-[13px] font-semibold text-text-primary">
                      ${t.creditUsd.toFixed(2)}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center justify-end gap-1">
                        {t.status !== 'SUSPENDED' && (
                          <button
                            onClick={() => tenantAction(t.id, 'suspend')}
                            disabled={actionLoading === t.id + 'suspend'}
                            className="px-2 py-1 rounded-md text-[11px] font-semibold text-warning bg-warning/10 border border-warning/20 hover:bg-warning/20 transition-colors disabled:opacity-50"
                            title="Suspender"
                          >
                            {actionLoading === t.id + 'suspend' ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Suspender'}
                          </button>
                        )}
                        {t.status !== 'ACTIVE' && (
                          <button
                            onClick={() => tenantAction(t.id, 'unban')}
                            disabled={actionLoading === t.id + 'unban'}
                            className="px-2 py-1 rounded-md text-[11px] font-semibold text-success bg-success/10 border border-success/20 hover:bg-success/20 transition-colors disabled:opacity-50"
                            title="Reativar"
                          >
                            {actionLoading === t.id + 'unban' ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Reativar'}
                          </button>
                        )}
                        {t.status !== 'BANNED' && (
                          <button
                            onClick={() => { if (confirm(`Banir permanentemente o tenant "${t.name}"?`)) tenantAction(t.id, 'ban'); }}
                            disabled={actionLoading === t.id + 'ban'}
                            className="px-2 py-1 rounded-md text-[11px] font-semibold text-danger bg-danger/10 border border-danger/20 hover:bg-danger/20 transition-colors disabled:opacity-50"
                            title="Banir"
                          >
                            {actionLoading === t.id + 'ban' ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Banir'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreateTenant && (
        <CreateTenantModal onClose={() => setShowCreateTenant(false)} onSuccess={() => { setShowCreateTenant(false); load(); }} />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: USUÁRIOS
// ══════════════════════════════════════════════════════════════════════════════

function UsersTab() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [filter, setFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get('/users');
      setUsers(res.data.data.users ?? []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const deleteUser = async (id: string, name: string) => {
    if (!confirm(`Remover permanentemente o usuário "${name}"?`)) return;
    try {
      await api.delete(`/users/${id}`);
      await load();
    } catch (e: any) { setError(e.response?.data?.message || 'Falha ao remover'); }
  };

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-accent animate-spin" /></div>;

  const filtered = users.filter(u => {
    const matchText = !filter || u.name.toLowerCase().includes(filter.toLowerCase()) || u.email.toLowerCase().includes(filter.toLowerCase());
    const matchRole = roleFilter === 'ALL' || u.role === roleFilter;
    return matchText && matchRole;
  });

  return (
    <div className="space-y-5">
      {error && <ErrorBar msg={error} onClose={() => setError('')} />}

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-text-primary">Gestão de Usuários</h2>
          <p className="text-[12px] text-text-muted mt-0.5">{users.length} conta{users.length !== 1 ? 's' : ''} cadastrada{users.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent hover:bg-accent-light text-white text-[12px] font-semibold transition-colors shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          Adicionar Usuário
        </button>
      </div>

      {/* ── Filters ── */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted pointer-events-none" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Buscar por nome ou email..."
            className="w-full pl-8 pr-3 py-2 rounded-lg bg-bg-input border border-border text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors"
          />
        </div>
        <select
          value={roleFilter}
          onChange={e => setRoleFilter(e.target.value)}
          className="px-3 py-2 rounded-lg bg-bg-input border border-border text-[12px] text-text-primary focus:outline-none focus:border-accent transition-colors"
        >
          <option value="ALL">Todos os níveis</option>
          <option value="ADM">ADM</option>
          <option value="TECNICO">Técnico</option>
          <option value="OBSERVADOR">Observador</option>
        </select>
      </div>

      {/* ── Table ── */}
      {filtered.length === 0 ? (
        <EmptyState icon={Users} title="Nenhum usuário encontrado" desc="Ajuste os filtros ou adicione um novo usuário." />
      ) : (
        <div className="rounded-xl border border-border bg-bg-card overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border bg-bg-secondary">
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Usuário</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Email</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Nível</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider hidden md:table-cell">Cadastro</th>
                <th className="py-3 px-4 text-right text-[10px] font-semibold text-text-muted uppercase tracking-wider">Ações</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => {
                const rc = roleCfg[u.role] ?? roleCfg.OBSERVADOR;
                return (
                  <tr key={u.id} className="border-b border-border last:border-0 hover:bg-bg-card-hover transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-accent/8 border border-border flex items-center justify-center text-[12px] font-bold text-accent-light shrink-0">
                          {u.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-[13px] font-semibold text-text-primary">{u.name}</span>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-[12px] text-text-secondary">{u.email}</td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-semibold ${rc.cls}`}>
                        <Shield className="w-3 h-3" />
                        {rc.label}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-[12px] text-text-muted hidden md:table-cell">
                      {new Date(u.createdAt).toLocaleDateString('pt-BR')}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => setEditingUser(u)}
                          className="p-1.5 rounded-md text-text-muted hover:text-accent-light hover:bg-accent/8 transition-colors"
                          title="Editar"
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => deleteUser(u.id, u.name)}
                          className="p-1.5 rounded-md text-text-muted hover:text-danger hover:bg-danger/8 transition-colors"
                          title="Remover"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <UserModal mode="create" onClose={() => setShowCreate(false)} onSuccess={() => { setShowCreate(false); load(); }} />
      )}
      {editingUser && (
        <UserModal mode="edit" user={editingUser} onClose={() => setEditingUser(null)} onSuccess={() => { setEditingUser(null); load(); }} />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: REDE
// ══════════════════════════════════════════════════════════════════════════════

function NetworkTab() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [meshTest, setMeshTest] = useState<MeshResult | null>(null);
  const [meshLoading, setMeshLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get('/v1/agent/nodes');
      setNodes(res.data.data.nodes ?? []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runMeshTest = async () => {
    setMeshLoading(true);
    setMeshTest(null);
    try {
      const res = await api.post('/v1/admin/mesh-test');
      setMeshTest(res.data.data);
    } catch (e: any) {
      setError(e.response?.data?.message || 'Falha no teste de malha');
    } finally { setMeshLoading(false); }
  };

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-accent animate-spin" /></div>;

  const filtered = nodes.filter(n => statusFilter === 'ALL' || n.status === statusFilter);
  const online   = nodes.filter(n => n.status === 'ONLINE').length;

  return (
    <div className="space-y-5">
      {error && <ErrorBar msg={error} onClose={() => setError('')} />}

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-text-primary">Malha de Nós</h2>
          <p className="text-[12px] text-text-muted mt-0.5">{online} de {nodes.length} nó{nodes.length !== 1 ? 's' : ''} online</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="p-2 rounded-lg border border-border text-text-muted hover:text-text-primary hover:bg-bg-card-hover transition-colors"
            title="Atualizar"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={runMeshTest}
            disabled={meshLoading || online === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-400 hover:bg-violet-500/20 text-[12px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {meshLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
            Testar Malha Completa
          </button>
        </div>
      </div>

      {/* ── Mesh Test Result ── */}
      {meshTest && (
        <div className={`rounded-xl border p-4 ${
          meshTest.responded === meshTest.totalNodes
            ? 'bg-success/5 border-success/20'
            : meshTest.responded > 0
              ? 'bg-warning/5 border-warning/20'
              : 'bg-danger/5 border-danger/20'
        }`}>
          <div className="flex items-center gap-2 mb-3">
            {meshTest.responded === meshTest.totalNodes
              ? <CheckCircle2 className="w-4 h-4 text-success" />
              : <AlertTriangle className="w-4 h-4 text-warning" />}
            <span className="text-[13px] font-bold text-text-primary">
              Resultado: {meshTest.responded}/{meshTest.totalNodes} nós responderam
            </span>
            <span className="text-[11px] text-text-muted ml-auto">{meshTest.durationMs}ms total</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {meshTest.results.map(r => (
              <div
                key={r.nodeId}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${
                  r.responded
                    ? 'bg-success/10 border-success/20 text-success'
                    : 'bg-danger/10 border-danger/20 text-danger'
                }`}
              >
                {r.responded ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                {r.nodeId.slice(0, 8)}
                {r.responded && r.rttMs >= 0 && <span className="opacity-70">·{r.rttMs}ms</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Filter ── */}
      <div className="flex items-center gap-2">
        {['ALL', 'ONLINE', 'OFFLINE', 'UPDATING'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
              statusFilter === s
                ? 'bg-accent/15 text-accent-light border border-accent/30'
                : 'text-text-muted border border-border hover:text-text-secondary'
            }`}
          >
            {s === 'ALL' ? `Todos (${nodes.length})` : s === 'ONLINE' ? `Online (${online})` : s}
          </button>
        ))}
      </div>

      {/* ── Nodes Table ── */}
      {filtered.length === 0 ? (
        <EmptyState icon={Server} title="Nenhum nó encontrado" desc="Nenhum nó corresponde ao filtro selecionado." />
      ) : (
        <div className="rounded-xl border border-border bg-bg-card overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border bg-bg-secondary">
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Nó</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Status</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider hidden lg:table-cell">Hardware</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider hidden md:table-cell">Localização</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider">Tipo</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider hidden md:table-cell">Tenant</th>
                <th className="py-3 px-4 text-[10px] font-semibold text-text-muted uppercase tracking-wider hidden lg:table-cell">Último ping</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((n) => (
                <tr key={n.id} className="border-b border-border last:border-0 hover:bg-bg-card-hover transition-colors">
                  <td className="py-3.5 px-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${
                        n.status === 'ONLINE' ? 'bg-success shadow-[0_0_6px] shadow-success/50' :
                        n.status === 'UPDATING' ? 'bg-warning animate-pulse' : 'bg-text-muted'
                      }`} />
                      <div>
                        <p className="text-[13px] font-semibold text-text-primary">{n.name}</p>
                        <p className="text-[10px] text-text-muted font-mono">{n.id.slice(0, 12)}…</p>
                      </div>
                    </div>
                  </td>
                  <td className="py-3.5 px-4">
                    <span className={`text-[11px] font-semibold ${
                      n.status === 'ONLINE' ? 'text-success' :
                      n.status === 'UPDATING' ? 'text-warning' : 'text-text-muted'
                    }`}>{n.status}</span>
                  </td>
                  <td className="py-3.5 px-4 hidden lg:table-cell">
                    <div className="text-[11px] text-text-muted">
                      <span className="flex items-center gap-1"><Cpu className="w-3 h-3" />{n.cpuCores} cores · {Math.round(n.ramMb / 1024)}GB</span>
                    </div>
                  </td>
                  <td className="py-3.5 px-4 hidden md:table-cell text-[12px] text-text-muted">
                    {[n.city, n.country].filter(Boolean).join(', ') || '—'}
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-text-muted">{n.infraType}</span>
                      {n.benchmarkTier && (
                        <span className={`text-[10px] font-bold ${nodeTierCfg[n.benchmarkTier] ?? 'text-text-muted'}`}>
                          {n.benchmarkTier}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 hidden md:table-cell text-[12px] text-text-muted">
                    {n.tenant?.name ?? <span className="italic opacity-50">Sem tenant</span>}
                  </td>
                  <td className="py-3.5 px-4 hidden lg:table-cell text-[11px] text-text-muted">
                    {new Date(n.lastPing).toLocaleString('pt-BR')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: AUDITORIA
// ══════════════════════════════════════════════════════════════════════════════

function AuditTab() {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('ALL');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/v1/admin/audit?limit=100');
      setLogs(res.data.data.logs ?? []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-accent animate-spin" /></div>;

  const actions = ['ALL', ...Array.from(new Set(logs.map(l => l.action)))];
  const filtered = logs.filter(l => actionFilter === 'ALL' || l.action === actionFilter);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-text-primary">Trilha de Auditoria</h2>
          <p className="text-[12px] text-text-muted mt-0.5">Registro imutável de ações administrativas</p>
        </div>
        <button onClick={load} className="p-2 rounded-lg border border-border text-text-muted hover:text-text-primary hover:bg-bg-card-hover transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Action filter */}
      <div className="flex flex-wrap gap-1.5">
        {actions.map(a => {
          const cfg = auditActionCfg[a];
          return (
            <button
              key={a}
              onClick={() => setActionFilter(a)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors border ${
                actionFilter === a
                  ? 'bg-accent/15 text-accent-light border-accent/30'
                  : 'text-text-muted border-border hover:text-text-secondary'
              }`}
            >
              {a === 'ALL' ? `Todos (${logs.length})` : (cfg?.label ?? a)}
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Eye} title="Nenhuma entrada encontrada" desc="Sem registros para este filtro." />
      ) : (
        <div className="rounded-xl border border-border bg-bg-card overflow-hidden">
          {filtered.map((entry, i) => {
            const cfg = auditActionCfg[entry.action];
            const isExpanded = expanded === entry.id;
            return (
              <div key={entry.id} className={`border-b border-border last:border-0 ${isExpanded ? 'bg-bg-secondary' : 'hover:bg-bg-card-hover'} transition-colors`}>
                <button
                  className="w-full flex items-center justify-between px-5 py-3.5 text-left"
                  onClick={() => setExpanded(isExpanded ? null : entry.id)}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className="text-[10px] text-text-muted font-mono shrink-0">
                      {new Date(entry.createdAt).toLocaleString('pt-BR')}
                    </span>
                    <span className={`shrink-0 text-[11px] font-bold ${cfg?.cls ?? 'text-text-secondary'}`}>
                      {cfg?.label ?? entry.action}
                    </span>
                    <span className="text-[12px] text-text-secondary truncate">
                      por <span className="text-text-primary font-semibold">{entry.actor?.name ?? 'sistema'}</span>
                      {entry.targetId && (
                        <span className="font-mono opacity-50"> · {entry.targetId.slice(0, 10)}</span>
                      )}
                    </span>
                  </div>
                  <ChevronDown className={`w-3.5 h-3.5 text-text-muted shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                </button>
                {isExpanded && entry.payload && (
                  <div className="px-5 pb-3.5">
                    <pre className="text-[11px] font-mono text-text-muted bg-bg-primary rounded-lg p-3 border border-border overflow-auto max-h-48">
                      {JSON.stringify(entry.payload, null, 2)}
                    </pre>
                    {entry.ipAddress && (
                      <p className="text-[10px] text-text-muted mt-1.5">IP: {entry.ipAddress}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MODALS & SHARED COMPONENTS
// ══════════════════════════════════════════════════════════════════════════════

function ErrorBar({ msg, onClose }: { msg: string; onClose: () => void }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-danger/8 border border-danger/25 text-danger text-[12px]">
      <AlertCircle className="w-4 h-4 shrink-0" />
      <span className="flex-1">{msg}</span>
      <button onClick={onClose} className="p-1 hover:bg-danger/15 rounded transition-colors">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function EmptyState({ icon: Icon, title, desc }: { icon: React.ElementType; title: string; desc: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="p-4 rounded-2xl bg-bg-card border border-border mb-4">
        <Icon className="w-8 h-8 text-text-muted" />
      </div>
      <p className="text-[14px] font-semibold text-text-primary">{title}</p>
      <p className="text-[12px] text-text-muted mt-1">{desc}</p>
    </div>
  );
}

function CreateTenantModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState('');
  const [document, setDocument] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api.post('/v1/admin/tenants', { name, document: document || undefined });
      onSuccess();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha ao criar tenant');
    } finally { setLoading(false); }
  };

  const inputClass = 'w-full px-3 py-2.5 rounded-lg bg-bg-input border border-border text-text-primary text-[13px] placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/10 transition-colors';

  return createPortal(
    <div
      className="animate-fade-in"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.65)' }}
      onClick={onClose}
    >
      <div className="bg-bg-card border border-border rounded-xl p-6 w-full max-w-md animate-slide-up shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center">
              <Building2 className="w-4 h-4 text-accent-light" />
            </div>
            <div>
              <h2 className="text-[14px] font-bold text-text-primary">Novo Tenant</h2>
              <p className="text-[11px] text-text-secondary">Criar uma nova organização na plataforma</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-card-hover transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && <div className="mb-4 p-3 rounded-lg bg-danger/8 border border-danger/25 text-danger text-[12px]">{error}</div>}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Nome da Organização *</label>
            <input value={name} onChange={e => setName(e.target.value)} required className={inputClass} placeholder="Acme Corp." />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-1.5">CNPJ / CPF (opcional)</label>
            <input value={document} onChange={e => setDocument(e.target.value)} className={inputClass} placeholder="00.000.000/0001-00" />
          </div>
          <div className="flex gap-3 pt-2 border-t border-border">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-border text-text-primary text-[13px] font-semibold hover:bg-bg-card-hover transition-colors">
              Cancelar
            </button>
            <button type="submit" disabled={loading} className="flex-1 py-2.5 rounded-lg bg-accent hover:bg-accent-light text-white text-[13px] font-semibold disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Criar Tenant
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

function UserModal({
  mode, user, onClose, onSuccess,
}: {
  mode: 'create' | 'edit';
  user?: UserRow;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName]     = useState(user?.name     ?? '');
  const [email, setEmail]   = useState(user?.email    ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole]     = useState(user?.role     ?? 'OBSERVADOR');
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (mode === 'create') {
        await api.post('/users', { name, email, password, role });
      } else {
        await api.put(`/users/${user!.id}`, { name, email, role });
      }
      onSuccess();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha na operação');
    } finally { setLoading(false); }
  };

  const inputClass = 'w-full px-3 py-2.5 rounded-lg bg-bg-input border border-border text-text-primary text-[13px] placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/10 transition-colors';

  return createPortal(
    <div
      className="animate-fade-in"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.65)' }}
      onClick={onClose}
    >
      <div className="bg-bg-card border border-border rounded-xl p-6 w-full max-w-md animate-slide-up shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${mode === 'create' ? 'bg-accent/10 border border-accent/20 text-accent-light' : 'bg-warning/10 border border-warning/20 text-warning'}`}>
              {mode === 'create' ? <Plus className="w-4 h-4" /> : <Edit className="w-4 h-4" />}
            </div>
            <div>
              <h2 className="text-[14px] font-bold text-text-primary">
                {mode === 'create' ? 'Adicionar Usuário' : 'Editar Usuário'}
              </h2>
              <p className="text-[11px] text-text-secondary">
                {mode === 'create' ? 'Conceder acesso à plataforma' : `Modificar: ${user?.name}`}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-card-hover transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && <div className="mb-4 p-3 rounded-lg bg-danger/8 border border-danger/25 text-danger text-[12px]">{error}</div>}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Nome</label>
            <input value={name} onChange={e => setName(e.target.value)} required className={inputClass} placeholder="Nome completo" />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required className={inputClass} placeholder="email@empresa.com" />
          </div>
          {mode === 'create' && (
            <div>
              <label className="block text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Senha</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} className={inputClass} placeholder="••••••••" />
            </div>
          )}
          <div>
            <label className="block text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Nível de Acesso</label>
            <select value={role} onChange={e => setRole(e.target.value as any)} className={inputClass}>
              <option value="ADM">Administrador Global (Acesso Total)</option>
              <option value="TECNICO">Técnico (Gerencia recursos e deploys)</option>
              <option value="OBSERVADOR">Observador (Somente leitura)</option>
            </select>
          </div>
          <div className="flex gap-3 pt-2 border-t border-border">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-border text-text-primary text-[13px] font-semibold hover:bg-bg-card-hover transition-colors">
              Cancelar
            </button>
            <button type="submit" disabled={loading} className="flex-1 py-2.5 rounded-lg bg-accent hover:bg-accent-light text-white text-[13px] font-semibold disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {mode === 'create' ? 'Criar Usuário' : 'Salvar Alterações'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
