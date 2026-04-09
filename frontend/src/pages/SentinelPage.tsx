/**
 * SentinelPage.tsx  (Sprint 16.4)
 *
 * Backoffice de governança com estética de alerta:
 *   - Paleta grafite / preto / vermelho escuro
 *   - Painel de Tenants com status e créditos circulantes
 *   - LGPD soft-delete de usuário
 *   - Mint de créditos com reason obrigatório
 *   - Botão do Pânico (M.A.D.) com modal de assinatura criptográfica
 *   - Trilha de auditoria
 */

import { useState, useEffect } from 'react';
import {
  Shield, AlertTriangle, Users, Wallet, Trash2, Plus, Ban,
  CheckCircle, RefreshCw, Loader2, Lock, Activity, Eye,
  ChevronRight, XCircle,
} from 'lucide-react';
import api from '../services/api';

/* ── Types ─────────────────────────────────────────────────────────────────── */

interface Tenant {
  id:        string;
  name:      string;
  document?: string;
  status:    'ACTIVE' | 'SUSPENDED' | 'BANNED';
  creditUsd: number;
  _count?:   { users: number; nodes: number; depinApps: number };
}

interface AuditEntry {
  id:        string;
  action:    string;
  targetId?: string;
  ipAddress?: string;
  createdAt: string;
  actor?:    { name: string; email: string } | null;
}

/* ── Colour helpers (inline — no Tailwind extension needed) ────────────────── */

const S = {
  page:         'min-h-screen bg-[#0a0a0a] text-[#d4d4d4] font-mono',
  header:       'border-b border-[#1f1f1f] bg-[#0d0d0d] px-6 py-4 flex items-center gap-3',
  section:      'px-6 py-6',
  card:         'bg-[#111111] border border-[#1f1f1f] rounded-lg',
  cardHead:     'px-4 py-3 border-b border-[#1f1f1f] flex items-center justify-between',
  badge: {
    ACTIVE:    'text-[10px] px-2 py-0.5 rounded bg-emerald-900/40 text-emerald-400 border border-emerald-700/30',
    SUSPENDED: 'text-[10px] px-2 py-0.5 rounded bg-yellow-900/40 text-yellow-400 border border-yellow-700/30',
    BANNED:    'text-[10px] px-2 py-0.5 rounded bg-red-900/40 text-red-400 border border-red-700/30',
  } as Record<string, string>,
  btnDanger:    'px-3 py-1.5 text-[12px] font-semibold bg-red-950 hover:bg-red-900 text-red-400 border border-red-800/50 rounded transition-colors',
  btnGhost:     'px-3 py-1.5 text-[12px] font-semibold bg-[#1a1a1a] hover:bg-[#222] text-[#aaa] border border-[#2a2a2a] rounded transition-colors',
  btnPrimary:   'px-3 py-1.5 text-[12px] font-semibold bg-[#1e3a2e] hover:bg-[#254d3a] text-emerald-400 border border-emerald-800/40 rounded transition-colors',
  input:        'w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-3 py-2 text-[13px] text-[#d4d4d4] placeholder:text-[#555] focus:outline-none focus:border-[#444]',
  label:        'block text-[11px] text-[#666] mb-1',
  panicBtn:     'w-full py-3 font-bold text-[14px] tracking-widest uppercase bg-[#1a0000] hover:bg-[#290000] text-red-500 border-2 border-red-900 rounded-lg transition-colors',
};

/* ── Tenant Row ────────────────────────────────────────────────────────────── */

function TenantRow({ tenant, onBan, onUnban }: {
  tenant: Tenant;
  onBan:   (id: string) => void;
  onUnban: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-[#1a1a1a] last:border-0 hover:bg-[#141414]">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-white">{tenant.name}</span>
          <span className={S.badge[tenant.status] ?? S.badge.SUSPENDED}>{tenant.status}</span>
        </div>
        {tenant.document && (
          <div className="text-[11px] text-[#555] mt-0.5">{tenant.document}</div>
        )}
      </div>

      <div className="text-right shrink-0 hidden md:block">
        <div className="text-[12px] text-emerald-400">${tenant.creditUsd.toFixed(2)}</div>
        <div className="text-[10px] text-[#555]">créditos</div>
      </div>

      {tenant._count && (
        <div className="flex gap-3 shrink-0 text-[11px] text-[#555] hidden lg:flex">
          <span>{tenant._count.users}u</span>
          <span>{tenant._count.nodes}n</span>
          <span>{tenant._count.depinApps}a</span>
        </div>
      )}

      <div className="flex gap-2 shrink-0">
        {tenant.status === 'BANNED' ? (
          <button onClick={() => onUnban(tenant.id)} className={S.btnGhost}>
            <CheckCircle className="w-3.5 h-3.5 inline mr-1" />Desbloquear
          </button>
        ) : (
          <button onClick={() => onBan(tenant.id)} className={S.btnDanger}>
            <Ban className="w-3.5 h-3.5 inline mr-1" />Banir
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Panic Modal ───────────────────────────────────────────────────────────── */

function PanicModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: (sig: string) => void }) {
  const [sig, setSig]     = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!sig.trim()) return;
    setLoading(true);
    try { await onConfirm(sig.trim()); }
    finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="w-full max-w-md bg-[#0d0d0d] border-2 border-red-900 rounded-xl p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <AlertTriangle className="w-6 h-6 text-red-500" />
          <h2 className="text-[16px] font-bold text-red-400 tracking-wide">PROTOCOLO M.A.D.</h2>
        </div>

        <p className="text-[12px] text-[#888] mb-4 leading-relaxed">
          Esta ação encerrará <strong className="text-red-400">todos os agentes</strong> na rede em cadeia:
          containers serão destruídos, WireGuard desmontado, cgroups purgados e os binários encerrados.
        </p>

        <div className="bg-red-950/30 border border-red-900/50 rounded px-3 py-2 text-[11px] text-red-400 mb-5 font-mono">
          Assine a mensagem <code className="bg-black/40 px-1 rounded">NEXUS_EMERGENCY_HALT</code> com sua
          chave privada Ed25519 e cole a assinatura em base64 abaixo.
        </div>

        <label className={S.label}>Assinatura Ed25519 (base64)</label>
        <textarea
          className={S.input + ' h-24 resize-none mb-4'}
          placeholder="Cole aqui a assinatura base64..."
          value={sig}
          onChange={e => setSig(e.target.value)}
        />

        <div className="flex gap-3">
          <button onClick={onClose} className={S.btnGhost + ' flex-1'}>
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={!sig.trim() || loading}
            className="flex-1 py-2 font-bold text-[13px] uppercase tracking-widest bg-red-950 hover:bg-red-900 disabled:opacity-50 text-red-400 border border-red-800 rounded transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'ATIVAR HALT'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────────────────────────────── */

export default function SentinelPage() {
  const [tenants, setTenants]     = useState<Tenant[]>([]);
  const [audit,   setAudit]       = useState<AuditEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showPanic, setShowPanic] = useState(false);

  // Mint form
  const [mintUserId,  setMintUserId]  = useState('');
  const [mintAmount,  setMintAmount]  = useState('');
  const [mintReason,  setMintReason]  = useState('');
  const [mintLoading, setMintLoading] = useState(false);
  const [mintMsg,     setMintMsg]     = useState('');

  // Delete form
  const [delUserId,  setDelUserId]  = useState('');
  const [delLoading, setDelLoading] = useState(false);
  const [delMsg,     setDelMsg]     = useState('');

  // New tenant form
  const [newName,    setNewName]    = useState('');
  const [newDoc,     setNewDoc]     = useState('');
  const [newLoading, setNewLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [tRes, aRes] = await Promise.all([
        api.get('/v1/admin/tenants'),
        api.get('/v1/admin/audit?limit=20'),
      ]);
      setTenants(tRes.data.data.tenants);
      setAudit(aRes.data.data.logs);
    } catch { /* errors shown inline */ }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  async function handleBan(id: string) {
    await api.post(`/v1/admin/tenants/${id}/ban`);
    load();
  }

  async function handleUnban(id: string) {
    await api.post(`/v1/admin/tenants/${id}/unban`);
    load();
  }

  async function handleCreateTenant() {
    if (!newName.trim()) return;
    setNewLoading(true);
    try {
      await api.post('/v1/admin/tenants', { name: newName.trim(), document: newDoc.trim() || undefined });
      setNewName(''); setNewDoc('');
      load();
    } finally { setNewLoading(false); }
  }

  async function handleMint() {
    if (!mintUserId || !mintAmount || !mintReason) return;
    setMintLoading(true); setMintMsg('');
    try {
      await api.post('/v1/admin/ledger/mint', {
        userId:    mintUserId,
        amountUsd: parseFloat(mintAmount),
        reason:    mintReason,
      });
      setMintMsg(`✓ $${mintAmount} creditados com sucesso.`);
      setMintUserId(''); setMintAmount(''); setMintReason('');
      load();
    } catch (e: any) {
      setMintMsg('✗ ' + (e.response?.data?.message ?? 'Erro'));
    } finally { setMintLoading(false); }
  }

  async function handleDelete() {
    if (!delUserId) return;
    setDelLoading(true); setDelMsg('');
    try {
      await api.delete(`/v1/admin/users/${delUserId}`);
      setDelMsg('✓ Dados mascarados (LGPD). Histórico financeiro preservado.');
      setDelUserId('');
      load();
    } catch (e: any) {
      setDelMsg('✗ ' + (e.response?.data?.message ?? 'Erro'));
    } finally { setDelLoading(false); }
  }

  async function handleHalt(sig: string) {
    await api.post('/v1/admin/emergency-halt', { signature: sig });
    setShowPanic(false);
    alert('HALT enviado para todos os agentes.');
  }

  const totalCredits = tenants.reduce((s, t) => s + (t.creditUsd ?? 0), 0);
  const activeTenants = tenants.filter(t => t.status === 'ACTIVE').length;

  return (
    <div className={S.page}>
      {/* Header */}
      <div className={S.header}>
        <Shield className="w-5 h-5 text-red-500" />
        <div>
          <h1 className="text-[16px] font-bold text-white tracking-wider">SENTINEL</h1>
          <p className="text-[10px] text-[#555] tracking-widest uppercase">Backoffice de Governança</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <button onClick={load} className={S.btnGhost}>
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setShowPanic(true)} className={S.panicBtn + ' w-auto px-5 py-2 text-[12px]'}>
            <AlertTriangle className="w-3.5 h-3.5 inline mr-2" />
            BOTÃO DO PÂNICO
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 text-red-600 animate-spin" />
        </div>
      ) : (
        <div className={S.section + ' space-y-6'}>

          {/* Summary row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Tenants Ativos', value: activeTenants,           icon: <Users className="w-4 h-4" />,    color: 'text-emerald-500' },
              { label: 'Total Tenants',  value: tenants.length,           icon: <Activity className="w-4 h-4" />, color: 'text-[#888]' },
              { label: 'Créditos em Rede', value: `$${totalCredits.toFixed(2)}`, icon: <Wallet className="w-4 h-4" />,   color: 'text-yellow-500' },
              { label: 'Banidos',         value: tenants.filter(t => t.status === 'BANNED').length, icon: <XCircle className="w-4 h-4" />, color: 'text-red-500' },
            ].map(s => (
              <div key={s.label} className={S.card + ' px-4 py-3'}>
                <div className={`mb-1.5 ${s.color}`}>{s.icon}</div>
                <div className="text-xl font-bold text-white">{s.value}</div>
                <div className="text-[11px] text-[#555] mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* Tenant list */}
            <div className={S.card + ' lg:col-span-2'}>
              <div className={S.cardHead}>
                <div>
                  <p className="text-[13px] font-semibold text-white">Tenants</p>
                  <p className="text-[11px] text-[#555]">Organizações registradas na rede</p>
                </div>
                <div className="flex gap-2">
                  <input
                    className={S.input + ' w-36'}
                    placeholder="Nome"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                  />
                  <input
                    className={S.input + ' w-32'}
                    placeholder="CNPJ"
                    value={newDoc}
                    onChange={e => setNewDoc(e.target.value)}
                  />
                  <button
                    onClick={handleCreateTenant}
                    disabled={!newName.trim() || newLoading}
                    className={S.btnPrimary + ' flex items-center gap-1'}
                  >
                    {newLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {tenants.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-[12px] text-[#555]">
                  Nenhum tenant cadastrado.
                </div>
              ) : (
                tenants.map(t => (
                  <TenantRow key={t.id} tenant={t} onBan={handleBan} onUnban={handleUnban} />
                ))
              )}
            </div>

            {/* Right column: mint + delete + panic */}
            <div className="space-y-4">

              {/* Credit Mint */}
              <div className={S.card}>
                <div className={S.cardHead}>
                  <p className="text-[13px] font-semibold text-white">Injetar Créditos</p>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <label className={S.label}>User ID</label>
                    <input className={S.input} placeholder="uuid..." value={mintUserId} onChange={e => setMintUserId(e.target.value)} />
                  </div>
                  <div>
                    <label className={S.label}>Valor (USD)</label>
                    <input className={S.input} type="number" placeholder="50.00" value={mintAmount} onChange={e => setMintAmount(e.target.value)} />
                  </div>
                  <div>
                    <label className={S.label}>Motivo <span className="text-red-500">*</span></label>
                    <input className={S.input} placeholder="Ex: reembolso, bonus testnet..." value={mintReason} onChange={e => setMintReason(e.target.value)} />
                  </div>
                  {mintMsg && (
                    <p className={`text-[11px] ${mintMsg.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}`}>{mintMsg}</p>
                  )}
                  <button
                    onClick={handleMint}
                    disabled={!mintUserId || !mintAmount || !mintReason || mintLoading}
                    className={S.btnPrimary + ' w-full justify-center flex items-center gap-2'}
                  >
                    {mintLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wallet className="w-3.5 h-3.5" />}
                    Creditар
                  </button>
                </div>
              </div>

              {/* LGPD Delete */}
              <div className={S.card}>
                <div className={S.cardHead}>
                  <p className="text-[13px] font-semibold text-white">Apagar Usuário (LGPD)</p>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <label className={S.label}>User ID</label>
                    <input className={S.input} placeholder="uuid..." value={delUserId} onChange={e => setDelUserId(e.target.value)} />
                  </div>
                  {delMsg && (
                    <p className={`text-[11px] ${delMsg.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}`}>{delMsg}</p>
                  )}
                  <button
                    onClick={handleDelete}
                    disabled={!delUserId || delLoading}
                    className={S.btnDanger + ' w-full flex items-center justify-center gap-2'}
                  >
                    {delLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    Mascarar PII
                  </button>
                </div>
              </div>

              {/* Panic button */}
              <button onClick={() => setShowPanic(true)} className={S.panicBtn + ' flex items-center justify-center gap-3'}>
                <AlertTriangle className="w-4 h-4" />
                BOTÃO DO PÂNICO
              </button>
            </div>
          </div>

          {/* Audit Trail */}
          <div className={S.card}>
            <div className={S.cardHead}>
              <div>
                <p className="text-[13px] font-semibold text-white">Trilha de Auditoria</p>
                <p className="text-[11px] text-[#555]">Últimas 20 ações administrativas — assinadas com SHA-256</p>
              </div>
              <Eye className="w-4 h-4 text-[#444]" />
            </div>
            {audit.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-[12px] text-[#555]">
                Nenhum registro de auditoria.
              </div>
            ) : (
              <div className="divide-y divide-[#1a1a1a]">
                {audit.map(a => (
                  <div key={a.id} className="flex items-center gap-4 px-4 py-2.5 hover:bg-[#141414] text-[12px]">
                    <span className="font-bold text-red-400 shrink-0 w-28">{a.action}</span>
                    <span className="text-[#555] font-mono truncate flex-1">{a.targetId ?? '—'}</span>
                    <span className="text-[#444] shrink-0">{a.actor?.name ?? 'system'}</span>
                    <span className="text-[#333] shrink-0 hidden md:block">
                      {new Date(a.createdAt).toLocaleString('pt-BR')}
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 text-[#333] shrink-0" />
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      )}

      {showPanic && (
        <PanicModal onClose={() => setShowPanic(false)} onConfirm={handleHalt} />
      )}
    </div>
  );
}
