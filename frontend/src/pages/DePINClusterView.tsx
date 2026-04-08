import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Network, ArrowLeft, Cpu, MemoryStick, Activity,
  Wifi, WifiOff, Loader2, RefreshCw, Globe,
  CheckCircle, XCircle, Clock, Link2,
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
}

interface LiveTelemetry {
  cpuPercent: number;
  memPercent: number;
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

/* ── Page ──────────────────────────────────────────────────── */
export default function DePINClusterView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [app, setApp] = useState<DePINApp | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState<Record<string, LiveTelemetry>>({});
  const [onlineNodes, setOnlineNodes] = useState<Set<string>>(new Set());
  const socketRef = useRef<Socket | null>(null);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await api.get(`/depin/apps/${id}`);
      setApp(res.data.data);
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
                        <span>{telemetry.cpuPercent.toFixed(0)}%</span>
                      </div>
                      <MiniBar value={telemetry.cpuPercent} color={telemetry.cpuPercent > 85 ? 'bg-danger' : 'bg-accent'} />
                      <div className="flex items-center justify-between text-[11px] text-text-muted">
                        <span className="flex items-center gap-1"><MemoryStick className="w-3 h-3" />RAM</span>
                        <span>{telemetry.memPercent.toFixed(0)}%</span>
                      </div>
                      <MiniBar value={telemetry.memPercent} color={telemetry.memPercent > 90 ? 'bg-danger' : 'bg-info'} />
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

      {/* Domains section */}
      <Card>
        <CardHeader
          title="Domínios"
          description="Aponte um domínio personalizado para este app com SSL automático."
          icon={<Globe className="w-4 h-4" />}
        />
        <CardDivider />

        <div className="space-y-4">
          {/* Ingress URL */}
          <div>
            <p className="text-[12px] text-text-muted mb-1.5">Endpoint Ingress (sempre disponível)</p>
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-bg-input border border-border font-mono text-[13px] text-text-secondary">
              <Link2 className="w-3.5 h-3.5 shrink-0 text-text-muted" />
              {window.location.origin}/depin/{app.slug}
            </div>
          </div>

          {/* Custom domain status */}
          {app.customDomain ? (
            <div>
              <p className="text-[12px] text-text-muted mb-1.5">Domínio personalizado</p>
              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-bg-input border border-border">
                <span className="font-mono text-[13px] text-text-primary">{app.customDomain}</span>
                <span className={`badge ${
                  app.sslStatus === 'ACTIVE'  ? 'badge-success' :
                  app.sslStatus === 'FAILED'  ? 'badge-danger'  : 'badge-warning'
                }`}>
                  SSL {app.sslStatus}
                </span>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-[12px] text-text-muted">
                Aponte um CNAME do seu domínio para:
              </p>
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-bg-input border border-border font-mono text-[13px] text-text-secondary">
                gateway.nexus.cloud
              </div>
              <p className="text-[12px] text-text-muted">
                Após a propagação DNS, o certificado SSL é emitido automaticamente em até 2 minutos.
              </p>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
