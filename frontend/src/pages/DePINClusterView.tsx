import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Network, ArrowLeft, Cpu, MemoryStick, Activity,
  Wifi, WifiOff, Loader2, RefreshCw, Globe,
  CheckCircle, XCircle, Clock, Zap, Star,
  Link2, Save, AlertCircle,
} from 'lucide-react';
import api from '../services/api';
import { io, Socket } from 'socket.io-client';
import { Card, CardHeader, CardDivider } from '../components/ui/Card';

/* ── Types ─────────────────────────────────────────────────── */
interface Assignment {
  id: string;
  status: 'RUNNING' | 'STOPPED' | 'PENDING' | 'FAILED';
  node: {
    id: string;
    name: string;
    country?: string;
    city?: string;
    lastPing?: string;
  };
}

interface DePINApp {
  id: string;
  name: string;
  slug: string;
  executionMode: 'WASM' | 'MICROVM';
  replicaCount: number;
  status: string;
  customDomain?: string;
  sslStatus?: 'PENDING' | 'ACTIVE' | 'FAILED';
  assignments: Assignment[];
  vCpu:   number;
  ramMb:  number;
  vramMb: number;
}

interface LiveTelemetry {
  cpuPercent?: number;
  cpu_percent?: number;
  cpu?: number;
  memPercent?: number;
  mem_percent?: number;
  memory_percent?: number;
}

/* ── Status helpers ────────────────────────────────────────── */
function AssignmentStatus({ status, isLive }: { status: string; isLive: boolean }) {
  if (isLive) {
    return (
      <span className="flex items-center gap-1.5 text-success text-[12px] font-semibold">
        <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse-status" />
        ONLINE
      </span>
    );
  }
  const map: Record<string, { icon: typeof CheckCircle; cls: string; label: string }> = {
    RUNNING: { icon: CheckCircle, cls: 'text-success', label: 'RUNNING' },
    STOPPED: { icon: XCircle,    cls: 'text-text-muted', label: 'STOPPED' },
    PENDING: { icon: Clock,      cls: 'text-warning', label: 'PENDING' },
    FAILED:  { icon: XCircle,    cls: 'text-danger', label: 'FAILED' },
  };
  const cfg = map[status] ?? map.STOPPED;
  const Icon = cfg.icon;
  return (
    <span className={`flex items-center gap-1.5 text-[12px] font-semibold ${cfg.cls}`}>
      <Icon className="w-3.5 h-3.5" />
      {cfg.label}
    </span>
  );
}

function MiniBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="w-full h-1 bg-white/[0.06] rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-700 ${color}`}
        style={{ width: `${Math.min(value, 100)}%` }}
      />
    </div>
  );
}

// ── Constellation Widget (Task 17.4) ─────────────────────────────────────────
// Shows the cluster as a star-named force-graph. Node IPs/names are hidden.

interface ConstellationNode { id: string; alias: string; status: string }
interface ConstellationEdge { from: string; to: string; type: 'net' | 'fail' }

const CW = 480; const CH = 260; const CCX = CW / 2; const CCY = CH / 2;

function ConstellationWidget({ appId }: { appId: string }) {
  const [nodes, setNodes] = useState<ConstellationNode[]>([]);
  const [edges, setEdges] = useState<ConstellationEdge[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const physRef   = useRef<{ id: string; alias: string; status: string; x: number; y: number; vx: number; vy: number }[]>([]);
  const frameRef  = useRef(0);
  const tickRef   = useRef(0);

  useEffect(() => {
    api.get(`/v1/scheduler/apps/${appId}/telemetry/net`)
      .then(r => { setNodes(r.data.data.nodes); setEdges(r.data.data.edges); })
      .catch(() => {});
  }, [appId]);

  useEffect(() => {
    const angle = (2 * Math.PI) / Math.max(nodes.length, 1);
    physRef.current = nodes.map((n, i) => ({
      ...n,
      x: CCX + Math.cos(i * angle) * 100,
      y: CCY + Math.sin(i * angle) * 90,
      vx: 0, vy: 0,
    }));
  }, [nodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) return;
    const ctx = canvas.getContext('2d')!;

    const tick = () => {
      tickRef.current++;
      const ps = physRef.current;

      // Physics
      for (let i = 0; i < ps.length; i++) {
        ps[i].vx += (CCX - ps[i].x) * 0.003;
        ps[i].vy += (CCY - ps[i].y) * 0.003;
        for (let j = 0; j < ps.length; j++) {
          if (i === j) continue;
          const dx = ps[i].x - ps[j].x; const dy = ps[i].y - ps[j].y;
          const d = Math.sqrt(dx*dx + dy*dy) || 1;
          const f = 800 / (d * d);
          ps[i].vx += (dx/d)*f; ps[i].vy += (dy/d)*f;
        }
        ps[i].vx *= 0.88; ps[i].vy *= 0.88;
        ps[i].x = Math.max(22, Math.min(CW - 22, ps[i].x + ps[i].vx));
        ps[i].y = Math.max(22, Math.min(CH - 22, ps[i].y + ps[i].vy));
      }

      // Background
      ctx.fillStyle = 'rgba(2,2,8,0.92)'; ctx.fillRect(0, 0, CW, CH);

      // Subtle star field
      if (tickRef.current === 1) {
        for (let s = 0; s < 60; s++) {
          const sx = Math.random() * CW; const sy = Math.random() * CH;
          ctx.beginPath(); ctx.arc(sx, sy, 0.6, 0, Math.PI*2);
          ctx.fillStyle = `rgba(255,255,255,${0.1 + Math.random()*0.2})`; ctx.fill();
        }
      }

      // Edges
      const nodeMap = new Map(ps.map(p => [p.id, p]));
      for (const e of edges) {
        const a = nodeMap.get(e.from); const b = nodeMap.get(e.to);
        if (!a || !b) continue;
        const pulse = 0.4 + 0.3 * Math.sin(tickRef.current * 0.03);
        const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        if (e.type === 'fail') {
          grad.addColorStop(0, `rgba(239,68,68,${pulse*0.4})`);
          grad.addColorStop(1, `rgba(239,68,68,${pulse*0.1})`);
        } else {
          grad.addColorStop(0, `rgba(99,102,241,${pulse*0.5})`);
          grad.addColorStop(0.5, `rgba(167,139,250,${pulse*0.6})`);
          grad.addColorStop(1, `rgba(99,102,241,${pulse*0.5})`);
        }
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = grad; ctx.lineWidth = 1; ctx.stroke();
      }

      // Stars (nodes)
      for (const p of ps) {
        const online = p.status === 'RUNNING';
        const pulse  = 1 + 0.15 * Math.sin(tickRef.current * 0.04);

        // Outer glow
        const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 20 * pulse);
        grd.addColorStop(0, online ? 'rgba(167,139,250,0.4)' : 'rgba(239,68,68,0.3)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.beginPath(); ctx.arc(p.x, p.y, 20 * pulse, 0, Math.PI*2);
        ctx.fillStyle = grd; ctx.fill();

        // Core star
        ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI*2);
        ctx.fillStyle   = online ? '#a78bfa' : '#7f1d1d';
        ctx.strokeStyle = online ? '#c4b5fd' : '#ef4444';
        ctx.lineWidth   = 1.5; ctx.fill(); ctx.stroke();

        // Alias label
        ctx.fillStyle = online ? '#e9d5ff' : '#fca5a5';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(p.alias, p.x, p.y + 19);
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [nodes, edges]);

  if (nodes.length === 0) return null;

  return (
    <Card padding="none">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Star className="w-4 h-4 text-violet-400" />
        <div>
          <h2 className="text-[15px] font-semibold text-text-primary">Constellation View</h2>
          <p className="text-[12px] text-text-secondary mt-0.5">
            {nodes.length} estrelas ativas — identidades reais ocultadas
          </p>
        </div>
      </div>
      <canvas
        ref={canvasRef} width={CW} height={CH}
        className="w-full rounded-b"
        style={{ background: '#020208', display: 'block' }}
      />
    </Card>
  );
}

// ── Hot-Resize Card ───────────────────────────────────────────────────────────

function HotResizeCard({ appId, initial }: { appId: string; initial: { vCpu: number; ramMb: number; vramMb: number } }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [ok, setOk]     = useState(false);
  const [err, setErr]   = useState('');

  const handleResize = async () => {
    setSaving(true); setOk(false); setErr('');
    try {
      await api.patch(`/v1/scheduler/apps/${appId}`, form);
      setOk(true);
      setTimeout(() => setOk(false), 3000);
    } catch (e: any) {
      setErr(e.response?.data?.message ?? 'Erro ao redimensionar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Hot-Resize"
        description="Ajuste CPU/RAM sem derrubar o workload. Cgroup v2 atualiza em < 1 s."
        icon={<Zap className="w-4 h-4"/>}
      />
      <CardDivider />
      <div className="space-y-4">
        {err && <p className="text-danger text-[13px]">{err}</p>}
        {ok  && <p className="text-success text-[13px]">Recursos atualizados sem downtime.</p>}

        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'CPU (millicores)', key: 'vCpu',  min: 100,  max: 64000, step: 100,  suffix: 'm' },
            { label: 'RAM (MB)',         key: 'ramMb', min: 128,  max: 524288, step: 128, suffix: 'MB' },
            { label: 'VRAM (MB)',        key: 'vramMb',min: 0,   max: 819200, step: 1024, suffix: 'MB' },
          ].map(f => (
            <div key={f.key}>
              <label className="block text-[12px] text-text-muted mb-1">{f.label}</label>
              <input
                type="number" min={f.min} max={f.max} step={f.step}
                value={(form as any)[f.key]}
                onChange={e => setForm(prev => ({ ...prev, [f.key]: Number(e.target.value) }))}
                className="input-field text-[13px] font-mono"
              />
              <span className="text-[10px] text-text-muted">{(form as any)[f.key].toLocaleString()} {f.suffix}</span>
            </div>
          ))}
        </div>

        <button onClick={handleResize} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-light disabled:opacity-50 text-white text-[13px] font-semibold transition-colors">
          {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin"/>Aplicando…</> : <><Zap className="w-3.5 h-3.5"/>Aplicar sem downtime</>}
        </button>
      </div>
    </Card>
  );
}

/* ── Page ──────────────────────────────────────────────────── */
export default function DePINClusterView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [app, setApp] = useState<DePINApp | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState<Record<string, LiveTelemetry>>({});
  const [onlineNodes, setOnlineNodes] = useState<Set<string>>(new Set());
  const socketRef = useRef<Socket | null>(null);

  // Domain management state
  const [domainInput, setDomainInput] = useState('');
  const [domainSaving, setDomainSaving] = useState(false);
  const [domainVerifying, setDomainVerifying] = useState(false);
  const [domainMsg, setDomainMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await api.get(`/v1/scheduler/apps/${id}`);
      setApp(res.data.data.app);
    } catch {
      setApp(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  // Real-time via Socket.io
  useEffect(() => {
    if (!app) return;
    const socket = io(window.location.origin, {
      auth: { token: localStorage.getItem('token') },
    });
    socketRef.current = socket;

    // Join rooms for each assigned node
    app.assignments.forEach(a => {
      socket.emit('join:server', a.node.id);
    });

    socket.on('node:telemetry', ({ nodeId, data }: { nodeId: string; data: LiveTelemetry }) => {
      setLive(prev => ({ ...prev, [nodeId]: data }));
      setOnlineNodes(prev => new Set([...prev, nodeId]));
    });

    socket.on('node:offline', ({ nodeId }: { nodeId: string }) => {
      setOnlineNodes(prev => { const n = new Set(prev); n.delete(nodeId); return n; });
    });

    // Hot-resize confirmation — refresh app state
    socket.on('app:resize', ({ appId }: { appId: string }) => {
      if (appId === app.id) load();
    });

    return () => { socket.disconnect(); };
  }, [app]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-accent animate-spin" />
      </div>
    );
  }

  if (!app) {
    return (
      <div className="text-center py-24 text-text-secondary">App não encontrado.</div>
    );
  }

  const handleAssignDomain = async () => {
    if (!app || !domainInput.trim()) return;
    setDomainSaving(true);
    setDomainMsg(null);
    try {
      await api.post(`/depin/apps/${app.id}/domain`, { domain: domainInput.trim() });
      setDomainMsg({ type: 'success', text: 'Domínio salvo. Verificando DNS e emitindo certificado SSL...' });
      setDomainInput('');
      load(); // refresh app to show new domain + sslStatus
    } catch (err: any) {
      setDomainMsg({ type: 'error', text: err?.response?.data?.message ?? 'Erro ao salvar domínio.' });
    } finally {
      setDomainSaving(false);
    }
  };

  const handleVerifyDns = async () => {
    if (!app) return;
    setDomainVerifying(true);
    setDomainMsg(null);
    try {
      const res = await api.get(`/depin/apps/${app.id}/domain/verify`);
      const { dnsOk } = res.data.data;
      if (dnsOk) {
        setDomainMsg({ type: 'success', text: 'DNS verificado. O certificado SSL está sendo provisionado.' });
      } else {
        setDomainMsg({ type: 'error', text: 'DNS ainda não propagou. Aguarde e tente novamente.' });
      }
      load();
    } catch (err: any) {
      setDomainMsg({ type: 'error', text: err?.response?.data?.message ?? 'Falha ao verificar DNS.' });
    } finally {
      setDomainVerifying(false);
    }
  };

  const onlineCount = app.assignments.filter(a => onlineNodes.has(a.node.id)).length;
  const runningCount = app.assignments.filter(a => a.status === 'RUNNING').length;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <button
          onClick={() => navigate('/depin')}
          className="flex items-center gap-1.5 text-[13px] text-text-muted hover:text-text-primary transition-colors mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Apps DePIN
        </button>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5 mb-1">
              <Network className="w-5 h-5 text-accent-light" />
              <h1 className="text-2xl font-bold text-text-primary">{app.name}</h1>
              <span className={`badge ${app.status === 'RUNNING' ? 'badge-success' : 'badge-neutral'}`}>
                {app.status}
              </span>
            </div>
            <p className="text-[13px] text-text-muted font-mono">/depin/{app.slug}</p>
          </div>

          <button
            onClick={load}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-white/[0.04] transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Nós Online',    value: onlineCount,            icon: <Wifi className="w-4 h-4" />,      color: 'text-success' },
          { label: 'Assignments',   value: app.assignments.length,  icon: <Activity className="w-4 h-4" />,  color: 'text-info' },
          { label: 'Réplicas alvo', value: app.replicaCount,        icon: <Cpu className="w-4 h-4" />,       color: 'text-accent-light' },
          { label: 'Running',       value: runningCount,            icon: <CheckCircle className="w-4 h-4" />, color: 'text-warning' },
        ].map(stat => (
          <Card key={stat.label} padding="md">
            <div className={`mb-2 ${stat.color}`}>{stat.icon}</div>
            <div className="text-2xl font-bold text-text-primary">{stat.value}</div>
            <div className="text-[12px] text-text-muted mt-0.5">{stat.label}</div>
          </Card>
        ))}
      </div>

      {/* Node assignment table */}
      <Card padding="none">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-[15px] font-semibold text-text-primary">Topologia do Cluster</h2>
          <p className="text-[13px] text-text-secondary mt-0.5">
            Nós atribuídos com status em tempo real
          </p>
        </div>

        {app.assignments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <WifiOff className="w-8 h-8 text-text-muted mb-3" />
            <p className="text-[13px] text-text-secondary">Nenhum nó atribuído ainda.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {app.assignments.map((a, i) => {
              const telemetry = live[a.node.id];
              const isLive = onlineNodes.has(a.node.id);
              const cpu = telemetry
                ? (telemetry.cpuPercent ?? telemetry.cpu_percent ?? telemetry.cpu ?? 0)
                : 0;
              const mem = telemetry
                ? (telemetry.memPercent ?? telemetry.mem_percent ?? telemetry.memory_percent ?? 0)
                : 0;
              return (
                <div key={a.id} className={`flex items-center gap-4 px-5 py-4 stagger-${Math.min(i + 1, 4)}`}>
                  {/* Status dot */}
                  <div className={`w-2 h-2 rounded-full shrink-0 ${isLive ? 'bg-success animate-pulse-status' : 'bg-text-muted'}`} />

                  {/* Node info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-medium text-text-primary truncate">{a.node.name}</span>
                      {a.node.country && (
                        <span className="text-[11px] text-text-muted">{a.node.city ?? a.node.country}</span>
                      )}
                    </div>
                    <div className="text-[12px] text-text-muted font-mono mt-0.5">{a.node.id.slice(0, 8)}…</div>
                  </div>

                  {/* Telemetry bars */}
                  {telemetry ? (
                    <div className="hidden md:flex flex-col gap-1.5 w-32 shrink-0">
                      <div className="flex items-center justify-between text-[11px] text-text-muted">
                        <span className="flex items-center gap-1"><Cpu className="w-3 h-3" />CPU</span>
                        <span>{cpu.toFixed(0)}%</span>
                      </div>
                      <MiniBar value={cpu} color={cpu > 85 ? 'bg-danger' : 'bg-accent'} />
                      <div className="flex items-center justify-between text-[11px] text-text-muted">
                        <span className="flex items-center gap-1"><MemoryStick className="w-3 h-3" />RAM</span>
                        <span>{mem.toFixed(0)}%</span>
                      </div>
                      <MiniBar value={mem} color={mem > 90 ? 'bg-danger' : 'bg-info'} />
                    </div>
                  ) : (
                    <div className="hidden md:block w-32 shrink-0 text-[12px] text-text-muted italic">
                      Sem telemetria
                    </div>
                  )}

                  {/* Assignment status */}
                  <div className="shrink-0">
                    <AssignmentStatus status={a.status} isLive={isLive} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Constellation View — star-aliased cluster map (Task 17.4) */}
      <ConstellationWidget appId={app.id} />

      {/* Hot-Resize */}
      <HotResizeCard
        appId={app.id}
        initial={{ vCpu: app.vCpu || 1000, ramMb: app.ramMb || 512, vramMb: app.vramMb || 0 }}
      />

      {/* Domains section */}
      <Card>
        <CardHeader
          title="Domínios"
          description="Aponte um domínio personalizado para este app com SSL automático."
          icon={<Globe className="w-4 h-4" />}
        />
        <CardDivider />

        <div className="space-y-5">
          {/* Ingress URL */}
          <div>
            <p className="text-[12px] text-text-muted mb-1.5">Endpoint Ingress (sempre disponível)</p>
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-bg-input border border-border font-mono text-[13px] text-text-secondary">
              <Link2 className="w-3.5 h-3.5 shrink-0 text-text-muted" />
              {window.location.origin}/depin/{app.slug}
            </div>
          </div>

          {/* Custom domain */}
          <div className="space-y-3">
            <p className="text-[12px] font-semibold text-text-secondary uppercase tracking-widest">Domínio Personalizado</p>

            {/* CNAME instruction */}
            <div className="rounded-lg border border-dashed border-border bg-bg-input/50 p-3 space-y-2">
              <p className="text-[11px] text-text-muted">1. Crie um registro CNAME no seu DNS apontando para:</p>
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-input border border-border font-mono text-[12px] text-accent-light select-all">
                {import.meta.env.VITE_GATEWAY_HOSTNAME ?? 'gateway.nexus.cloud'}
              </div>
              <p className="text-[11px] text-text-muted">2. Após a propagação DNS, informe o domínio abaixo e o certificado SSL é emitido automaticamente.</p>
            </div>

            {/* Active domain display */}
            {app.customDomain && (
              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-bg-input border border-border">
                <div className="flex items-center gap-2">
                  <Globe className="w-3.5 h-3.5 text-text-muted" />
                  <span className="font-mono text-[13px] text-text-primary">{app.customDomain}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`badge ${
                    app.sslStatus === 'ACTIVE'  ? 'badge-success' :
                    app.sslStatus === 'FAILED'  ? 'badge-danger'  : 'badge-warning'
                  }`}>
                    SSL {app.sslStatus ?? 'PENDING'}
                  </span>
                  {app.sslStatus !== 'ACTIVE' && (
                    <button
                      onClick={handleVerifyDns}
                      disabled={domainVerifying}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-bg-card-hover border border-border text-[11px] font-semibold text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                    >
                      {domainVerifying ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                      Verificar DNS
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Input to set / change domain */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder={app.customDomain ? 'Substituir por outro domínio...' : 'meuapp.exemplo.com'}
                value={domainInput}
                onChange={e => setDomainInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAssignDomain(); }}
                className="flex-1 bg-bg-input border border-border rounded-lg px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60 font-mono transition-colors"
              />
              <button
                onClick={handleAssignDomain}
                disabled={domainSaving || !domainInput.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent hover:bg-accent-light disabled:opacity-50 text-white text-[13px] font-semibold transition-all"
              >
                {domainSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {domainSaving ? 'Salvando...' : 'Ativar'}
              </button>
            </div>

            {/* Feedback message */}
            {domainMsg && (
              <div className={`flex items-start gap-2 px-3 py-2.5 rounded-lg border text-[12px] ${
                domainMsg.type === 'success'
                  ? 'bg-success/10 border-success/30 text-success'
                  : 'bg-danger/10 border-danger/30 text-danger'
              }`}>
                {domainMsg.type === 'success'
                  ? <CheckCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  : <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                }
                {domainMsg.text}
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
