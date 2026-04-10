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

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Shield, AlertTriangle, Users, Wallet, Trash2, Plus, Ban,
  CheckCircle, RefreshCw, Loader2, Activity,
  ChevronRight, XCircle, Terminal, Zap, Award, Network, Eye,
} from 'lucide-react';
import api from '../services/api';
import { io, Socket } from 'socket.io-client';

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

interface LogEntry {
  level:     'error' | 'warn' | 'fatal';
  message:   string;
  nodeId?:   string;
  timestamp: string;
}

interface BenchmarkNode {
  id:              string;
  name:            string;
  status:          string;
  infraType:       'SWARM' | 'CLOUD_MANAGED' | 'ON_PREMISE';
  benchmarkTier:   'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM' | null;
  benchmarkScore:  number | null;
  lastBenchmarkAt: string | null;
  country:         string | null;
  cpuCores:        number;
  ramMb:           number;
  gpuCount:        number;
  gpuModel:        string | null;
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
  stressBtn:    'w-full py-2.5 font-bold text-[13px] tracking-widest uppercase bg-[#0d1a00] hover:bg-[#142600] text-[#7ee040] border-2 border-[#2d5000] rounded-lg transition-colors',
  tierColor: {
    PLATINUM: 'text-[#e2e8f0] bg-[#1a1a2e] border-[#4a4a8a]',
    GOLD:     'text-[#fde68a] bg-[#1a1500] border-[#7a6000]',
    SILVER:   'text-[#d1d5db] bg-[#151515] border-[#3a3a3a]',
    BRONZE:   'text-[#d97706] bg-[#140a00] border-[#7a4500]',
  } as Record<string, string>,
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

/* ── Peer Latency Heatmap ──────────────────────────────────────────────────── */

function latencyColor(ms: number | null | undefined): string {
  if (ms == null) return '#1a1a1a';          // no data — dark
  if (ms < 5)    return '#166534';           // < 5 ms  — deep green
  if (ms < 15)   return '#15803d';           // < 15 ms — green
  if (ms < 40)   return '#854d0e';           // < 40 ms — amber
  if (ms < 100)  return '#7c2d12';           // < 100ms — orange-red
  return '#450a0a';                          // ≥ 100ms — red
}
function latencyText(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1)    return '<1';
  return ms.toFixed(0);
}

function PeerLatencyHeatmap({ data }: {
  data: { nodes: { id: string; name: string }[]; matrix: Record<string, Record<string, number>> };
}) {
  const { nodes, matrix } = data;
  if (nodes.length < 2) return (
    <div className="flex items-center justify-center h-16 text-[11px] text-[#444]">
      Precisa de pelo menos 2 nós com benchmark inter-pares concluído.
    </div>
  );

  return (
    <div className="overflow-x-auto">
      <table className="text-[10px] font-mono border-collapse">
        <thead>
          <tr>
            <th className="px-2 py-1 text-[#444] text-left w-24">De \ Para</th>
            {nodes.map(n => (
              <th key={n.id} className="px-2 py-1 text-[#666] text-center max-w-[60px] truncate" title={n.name}>
                {n.name.slice(0, 8)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nodes.map(rowNode => (
            <tr key={rowNode.id}>
              <td className="px-2 py-1 text-[#666] font-semibold truncate max-w-[96px]" title={rowNode.name}>
                {rowNode.name.slice(0, 10)}
              </td>
              {nodes.map(colNode => {
                const isSelf = rowNode.id === colNode.id;
                const ms = isSelf ? null : (matrix[rowNode.id]?.[colNode.id] ?? matrix[colNode.id]?.[rowNode.id] ?? null);
                return (
                  <td
                    key={colNode.id}
                    className="text-center px-2 py-1 rounded"
                    style={{
                      background: isSelf ? '#0d0d0d' : latencyColor(ms),
                      color: isSelf ? '#222' : ms == null ? '#333' : '#e5e5e5',
                      minWidth: 44,
                    }}
                    title={isSelf ? rowNode.name : `${rowNode.name} → ${colNode.name}: ${latencyText(ms)} ms`}
                  >
                    {isSelf ? '·' : `${latencyText(ms)}ms`}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-3 mt-3 px-1">
        <span className="text-[10px] text-[#555]">Legenda:</span>
        {[
          { color: '#166534', label: '< 5ms' },
          { color: '#15803d', label: '< 15ms' },
          { color: '#854d0e', label: '< 40ms' },
          { color: '#7c2d12', label: '< 100ms' },
          { color: '#450a0a', label: '≥ 100ms' },
          { color: '#1a1a1a', label: 'sem dados' },
        ].map(({ color, label }) => (
          <div key={label} className="flex items-center gap-1">
            <div className="w-3 h-3 rounded" style={{ background: color }} />
            <span className="text-[10px] text-[#555]">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Sentinel Net Graph ────────────────────────────────────────────────────── */

interface NetNode {
  id: string; name: string; status: string;
  x: number; y: number; vx: number; vy: number;
}

const NET_W = 480; const NET_H = 240;
const CX = NET_W / 2; const CY = NET_H / 2;

function SentinelNetGraph({
  nodes: rawNodes,
  onNodeClick,
  selectedId,
}: {
  nodes: BenchmarkNode[];
  onNodeClick: (id: string) => void;
  selectedId: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodesRef  = useRef<NetNode[]>([]);
  const frameRef  = useRef<number>(0);

  // Initialise physics nodes from benchmark data
  useEffect(() => {
    const angle = (2 * Math.PI) / Math.max(rawNodes.length, 1);
    nodesRef.current = rawNodes.map((n, i) => ({
      id: n.id, name: n.name, status: n.status,
      x: CX + Math.cos(i * angle) * 90,
      y: CY + Math.sin(i * angle) * 80,
      vx: 0, vy: 0,
    }));
  }, [rawNodes]);

  // Click handler — find nearest node
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    for (const n of nodesRef.current) {
      const dx = n.x - mx; const dy = n.y - my;
      if (Math.sqrt(dx*dx + dy*dy) <= 14) { onNodeClick(n.id); return; }
    }
    onNodeClick(''); // click on empty → clear filter
  }, [onNodeClick]);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const tick = () => {
      const ns = nodesRef.current;
      // Spring physics — light repulsion + center pull
      for (let i = 0; i < ns.length; i++) {
        ns[i].vx += (CX - ns[i].x) * 0.004;
        ns[i].vy += (CY - ns[i].y) * 0.004;
        for (let j = 0; j < ns.length; j++) {
          if (i === j) continue;
          const dx = ns[i].x - ns[j].x; const dy = ns[i].y - ns[j].y;
          const d = Math.sqrt(dx*dx + dy*dy) || 1;
          const f = 900 / (d * d);
          ns[i].vx += (dx / d) * f;
          ns[i].vy += (dy / d) * f;
        }
        ns[i].vx *= 0.85; ns[i].vy *= 0.85;
        ns[i].x = Math.max(18, Math.min(NET_W - 18, ns[i].x + ns[i].vx));
        ns[i].y = Math.max(18, Math.min(NET_H - 18, ns[i].y + ns[i].vy));
      }

      // Draw
      ctx.clearRect(0, 0, NET_W, NET_H);

      // Edges
      for (let i = 0; i < ns.length; i++) {
        for (let j = i+1; j < ns.length; j++) {
          const a = ns[i]; const b = ns[j];
          const fail = a.status !== 'ONLINE' || b.status !== 'ONLINE';
          ctx.beginPath();
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = fail ? 'rgba(239,68,68,0.25)' : 'rgba(99,102,241,0.2)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // Nodes
      for (const n of ns) {
        const isOffline  = n.status !== 'ONLINE';
        const isSelected = n.id === selectedId;
        const r = isSelected ? 13 : 10;

        // Glow for selected
        if (isSelected) {
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(239,68,68,0.15)'; ctx.fill();
        }

        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle   = isOffline ? '#7f1d1d' : '#1e3a2e';
        ctx.strokeStyle = isOffline ? '#ef4444' : '#22c55e';
        ctx.lineWidth   = isSelected ? 2 : 1;
        ctx.fill(); ctx.stroke();

        // Label
        ctx.fillStyle = isOffline ? '#fca5a5' : '#86efac';
        ctx.font = '8px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(n.name.slice(0, 8), n.x, n.y + r + 9);
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [selectedId]);

  if (rawNodes.length === 0) return (
    <div className="flex items-center justify-center h-20 text-[11px] text-[#444]">
      Nenhum nó conectado para exibir.
    </div>
  );

  return (
    <canvas
      ref={canvasRef} width={NET_W} height={NET_H}
      className="w-full cursor-crosshair rounded"
      style={{ background: '#050505', maxHeight: 240 }}
      onClick={handleClick}
      title="Clique em um nó para filtrar os logs"
    />
  );
}

/* ── Log Terminal ──────────────────────────────────────────────────────────── */

function LogTerminal({ logs, filterNodeId }: { logs: LogEntry[]; filterNodeId: string }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const filtered = filterNodeId
    ? logs.filter(l => l.nodeId === filterNodeId)
    : logs;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [filtered.length]);

  const levelColor = (level: LogEntry['level']) =>
    level === 'fatal' ? '#ff4444'
    : level === 'error' ? '#ff7777'
    : '#f59e0b';

  return (
    <div
      className="h-52 overflow-y-auto rounded bg-[#050505] border border-[#1a1a1a] p-2 font-mono text-[11px] space-y-0.5"
      style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a #0d0d0d' }}
    >
      {filtered.length === 0 ? (
        <div className="flex items-center justify-center h-full text-[#333]">
          Aguardando logs de erro...
        </div>
      ) : (
        filtered.map((l, i) => (
          <div key={i} className="flex gap-2 items-start">
            <span className="text-[#444] shrink-0">{new Date(l.timestamp).toLocaleTimeString('pt-BR')}</span>
            <span style={{ color: levelColor(l.level) }} className="shrink-0 font-bold">[{l.level.toUpperCase()}]</span>
            {l.nodeId && <span className="text-[#5a5aaa] shrink-0">[{l.nodeId.slice(0, 8)}]</span>}
            <span className="text-[#888] break-all">{l.message}</span>
          </div>
        ))
      )}
      <div ref={bottomRef}/>
    </div>
  );
}

/* ── Benchmark Table ───────────────────────────────────────────────────────── */

function TierBadge({ tier }: { tier: string | null }) {
  if (!tier) return <span className="text-[10px] text-[#444]">—</span>;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-bold ${S.tierColor[tier] ?? S.tierColor.BRONZE}`}>
      {tier}
    </span>
  );
}

function InfraTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    CLOUD_MANAGED: 'text-blue-400 border-blue-800/40 bg-blue-950/30',
    ON_PREMISE:    'text-purple-400 border-purple-800/40 bg-purple-950/30',
    SWARM:         'text-[#888] border-[#333] bg-[#111]',
  };
  const labels: Record<string, string> = {
    CLOUD_MANAGED: 'CLOUD',
    ON_PREMISE:    'ON-PREM',
    SWARM:         'SWARM',
  };
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold ${colors[type] ?? colors.SWARM}`}>
      {labels[type] ?? type}
    </span>
  );
}

/* ── Main Page ─────────────────────────────────────────────────────────────── */

export default function SentinelPage() {
  const [tenants, setTenants]     = useState<Tenant[]>([]);
  const [audit,   setAudit]       = useState<AuditEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showPanic, setShowPanic] = useState(false);

  // Sprint 17.3 — Live log terminal
  const [logs, setLogs]               = useState<LogEntry[]>([]);
  const [logFilter, setLogFilter]     = useState('');
  const socketRef                     = useRef<Socket | null>(null);

  // Sprint 17.4 — Benchmark
  const [benchNodes, setBenchNodes]     = useState<BenchmarkNode[]>([]);
  const [runningBench, setRunningBench] = useState<string | null>(null);

  // Peer latency matrix
  const [peerMatrix, setPeerMatrix] = useState<{
    nodes: { id: string; name: string }[];
    matrix: Record<string, Record<string, number>>;
  } | null>(null);

  // Sprint 17.5 — Stress test
  const [stressLoading, setStressLoad] = useState(false);
  const [stressMsg, setStressMsg]      = useState('');
  const [countdown, setCountdown]      = useState<number | null>(null);

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
      const [tRes, aRes, bRes, mRes] = await Promise.all([
        api.get('/v1/admin/tenants'),
        api.get('/v1/admin/audit?limit=20'),
        api.get('/v1/admin/nodes/benchmarks').catch(() => ({ data: { data: { nodes: [] } } })),
        api.get('/v1/admin/nodes/peer-matrix').catch(() => null),
      ]);
      setTenants(tRes.data.data.tenants);
      setAudit(aRes.data.data.logs);
      setBenchNodes(bRes.data.data.nodes);
      if (mRes) setPeerMatrix(mRes.data.data);
    } catch { /* errors shown inline */ }
    finally { setLoading(false); }
  };

  // Load recent backend logs
  const loadLogs = async () => {
    try {
      const res = await api.get('/v1/admin/logs?limit=100');
      setLogs(res.data.data.logs);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    load();
    loadLogs();

    // Real-time socket for logs, benchmark, stress test
    const socket = io(window.location.origin, {
      auth: { token: localStorage.getItem('token') },
    });
    socketRef.current = socket;

    socket.on('sentinel:log', (entry: LogEntry) => {
      setLogs(prev => [...prev.slice(-499), entry]);
    });

    socket.on('sentinel:benchmark_done', () => {
      setRunningBench(null);
      api.get('/v1/admin/nodes/benchmarks').then(r => setBenchNodes(r.data.data.nodes)).catch(() => {});
    });

    socket.on('sentinel:stress_test_started', (data: { dispatched: number; ntpEpochMs: number; durationSecs: number }) => {
      const msUntilStart = data.ntpEpochMs - Date.now();
      const totalMs = msUntilStart + data.durationSecs * 1000;
      let remaining = Math.ceil(totalMs / 1000);
      setCountdown(remaining);
      const t = setInterval(() => {
        remaining--;
        setCountdown(remaining);
        if (remaining <= 0) { clearInterval(t); setCountdown(null); }
      }, 1000);
    });

    socket.on('sentinel:stress_result', () => {
      // Each node sends its result — just refresh after a delay
      setTimeout(() => api.get('/v1/admin/nodes/benchmarks')
        .then(r => setBenchNodes(r.data.data.nodes)).catch(() => {}), 2000);
    });

    return () => { socket.disconnect(); };
  }, []);

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

  // Sprint 17.4
  async function handleRunBenchmark(nodeId: string) {
    setRunningBench(nodeId);
    try {
      await api.post(`/v1/admin/nodes/${nodeId}/benchmark`);
    } catch (e: any) {
      setRunningBench(null);
      alert(e.response?.data?.message ?? 'Nó não conectado.');
    }
  }

  async function handleSetInfraType(nodeId: string, infraType: string) {
    await api.post(`/v1/admin/nodes/${nodeId}/infra-type`, { infraType });
    setBenchNodes(prev => prev.map(n => n.id === nodeId ? { ...n, infraType: infraType as any } : n));
  }

  // Sprint 17.5
  async function handleStressTest() {
    setStressLoad(true); setStressMsg('');
    try {
      const res = await api.post('/v1/admin/stress-test', { durationSecs: 30, jitterMaxMs: 5000 });
      const d = res.data.data;
      setStressMsg(`✓ Stress test disparado para ${d.dispatched} nós. Início em 10s.`);
    } catch (e: any) {
      setStressMsg('✗ ' + (e.response?.data?.message ?? 'Erro'));
    } finally {
      setStressLoad(false);
    }
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

          {/* ── Sprint 17.2 + 17.3 — Nexus Net Graph + Log Terminal ─────── */}
          <div className={S.card}>
            <div className={S.cardHead}>
              <div className="flex items-center gap-2">
                <Network className="w-4 h-4 text-[#6366f1]" />
                <div>
                  <p className="text-[13px] font-semibold text-white">Nexus Net Global</p>
                  <p className="text-[10px] text-[#555]">Clique num nó para filtrar os logs abaixo</p>
                </div>
              </div>
              {logFilter && (
                <button onClick={() => setLogFilter('')} className={S.btnGhost + ' text-[10px] px-2 py-1'}>
                  <XCircle className="w-3 h-3 inline mr-1" />
                  Limpar
                </button>
              )}
            </div>
            <div className="p-3">
              <SentinelNetGraph
                nodes={benchNodes}
                selectedId={logFilter}
                onNodeClick={id => setLogFilter(id)}
              />
            </div>

            <div className="border-t border-[#1a1a1a]">
              <div className="px-4 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="w-3.5 h-3.5 text-[#7ee040]" />
                  <p className="text-[12px] font-semibold text-white">
                    Caixa Preta
                    {logFilter && (
                      <span className="ml-2 text-[10px] text-[#6366f1] font-mono">
                        [{logFilter.slice(0, 8)}…]
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    className={S.input + ' w-36 text-[11px] py-1'}
                    placeholder="nodeId manual..."
                    value={logFilter}
                    onChange={e => setLogFilter(e.target.value)}
                  />
                  <button onClick={loadLogs} className={S.btnGhost}>
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="px-3 pb-3">
                <LogTerminal logs={logs} filterNodeId={logFilter.trim()}/>
              </div>
            </div>
          </div>

          {/* ── Sprint 17.4 — Benchmark Engine ────────────────────────── */}
          <div className={S.card}>
            <div className={S.cardHead}>
              <div className="flex items-center gap-2">
                <Award className="w-4 h-4 text-yellow-400" />
                <div>
                  <p className="text-[13px] font-semibold text-white">Hybrid Benchmark Engine — Selos de Qualidade</p>
                  <p className="text-[11px] text-[#555]">5 probes: CPU SHA-256, RAM, Storage IOPS, GPU FP16, Mesh WireGuard</p>
                </div>
              </div>
            </div>
            {benchNodes.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-[12px] text-[#555]">
                Nenhum nó com dados de benchmark. Dispare um benchmark abaixo.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-[#1a1a1a] text-[10px] text-[#555] uppercase tracking-widest">
                      <th className="px-4 py-2 text-left">Nó</th>
                      <th className="px-2 py-2 text-left">Tipo</th>
                      <th className="px-2 py-2 text-center">Tier</th>
                      <th className="px-2 py-2 text-center">Score</th>
                      <th className="px-2 py-2 text-left">CPU/RAM/GPU</th>
                      <th className="px-2 py-2 text-center">Último Bench</th>
                      <th className="px-2 py-2 text-center">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#111]">
                    {benchNodes.map(n => (
                      <tr key={n.id} className="hover:bg-[#141414]">
                        <td className="px-4 py-2.5">
                          <div className="font-semibold text-white">{n.name}</div>
                          <div className="text-[10px] text-[#444]">{n.country ?? '?'}</div>
                        </td>
                        <td className="px-2 py-2.5">
                          <InfraTypeBadge type={n.infraType}/>
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          <TierBadge tier={n.benchmarkTier}/>
                        </td>
                        <td className="px-2 py-2.5 text-center text-white font-mono">
                          {n.benchmarkScore != null ? n.benchmarkScore.toFixed(1) : '—'}
                        </td>
                        <td className="px-2 py-2.5 text-[#666]">
                          {n.cpuCores}c · {Math.round(n.ramMb/1024)}GB
                          {n.gpuCount > 0 && <span className="text-purple-400 ml-1">GPU×{n.gpuCount}</span>}
                        </td>
                        <td className="px-2 py-2.5 text-center text-[#444]">
                          {n.lastBenchmarkAt
                            ? new Date(n.lastBenchmarkAt).toLocaleDateString('pt-BR')
                            : '—'}
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => handleRunBenchmark(n.id)}
                              disabled={runningBench === n.id}
                              className={S.btnGhost + ' text-[10px] px-2 py-1'}
                            >
                              {runningBench === n.id
                                ? <Loader2 className="w-3 h-3 animate-spin inline"/>
                                : <Zap className="w-3 h-3 inline"/>}
                            </button>
                            <select
                              value={n.infraType}
                              onChange={e => handleSetInfraType(n.id, e.target.value)}
                              className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-1 py-0.5 text-[10px] text-[#aaa]"
                            >
                              <option value="SWARM">SWARM</option>
                              <option value="CLOUD_MANAGED">CLOUD</option>
                              <option value="ON_PREMISE">ON-PREM</option>
                            </select>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Peer Latency Matrix ───────────────────────────────────── */}
          <div className={S.card}>
            <div className={S.cardHead}>
              <div className="flex items-center gap-2">
                <Network className="w-4 h-4 text-[#6366f1]" />
                <div>
                  <p className="text-[13px] font-semibold text-white">Matriz de Latência Inter-Nós</p>
                  <p className="text-[11px] text-[#555]">RTT real entre cada par WireGuard — atualizado após benchmark</p>
                </div>
              </div>
              <button onClick={() => api.get('/v1/admin/nodes/peer-matrix').then(r => setPeerMatrix(r.data.data)).catch(() => {})} className={S.btnGhost}>
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="p-4">
              {peerMatrix && peerMatrix.nodes.length >= 2
                ? <PeerLatencyHeatmap data={peerMatrix} />
                : <div className="flex items-center justify-center h-16 text-[11px] text-[#444]">
                    Rode um benchmark nos nós para popular a matriz.
                  </div>
              }
            </div>
          </div>

          {/* ── Sprint 17.5 — Global Swarm Stress Test ────────────────── */}
          <div className={S.card + ' border-[#2d5000]'}>
            <div className={S.cardHead + ' border-[#2d5000]'}>
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-[#7ee040]" />
                <div>
                  <p className="text-[13px] font-semibold text-white">Global Swarm Stress Test — Modo Deus</p>
                  <p className="text-[11px] text-[#555]">
                    Dispara benchmark em TODOS os nós conectados simultaneamente (NTP-synced, jitter 0–5 s).
                  </p>
                </div>
              </div>
              {countdown !== null && (
                <div className="text-[12px] text-[#7ee040] font-mono font-bold animate-pulse">
                  T-{countdown}s
                </div>
              )}
            </div>
            <div className="p-4 space-y-3">
              {stressMsg && (
                <p className={`text-[12px] font-mono ${stressMsg.startsWith('✓') ? 'text-[#7ee040]' : 'text-red-400'}`}>
                  {stressMsg}
                </p>
              )}
              <p className="text-[11px] text-[#555]">
                Duração: 30 s · Jitter máximo: 5 s · Agrega métricas de todos os nós para valuation da rede.
                Resultados aparecem na tabela de benchmark em tempo real.
              </p>
              <button
                onClick={handleStressTest}
                disabled={stressLoading || countdown !== null}
                className={S.stressBtn + ' flex items-center justify-center gap-2 disabled:opacity-50'}
              >
                {stressLoading
                  ? <><Loader2 className="w-4 h-4 animate-spin"/>Despachando…</>
                  : countdown !== null
                    ? <><Zap className="w-4 h-4"/>TESTE EM ANDAMENTO — T-{countdown}s</>
                    : <><Zap className="w-4 h-4"/>DISPARAR STRESS TEST GLOBAL</>}
              </button>
            </div>
          </div>

        </div>
      )}

      {showPanic && (
        <PanicModal onClose={() => setShowPanic(false)} onConfirm={handleHalt} />
      )}
    </div>
  );
}
