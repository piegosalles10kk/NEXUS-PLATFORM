/**
 * SonarRadarPage.tsx  (Sprint 15.2 + 15.3)
 *
 * Two panels:
 *   Left  — Sonar Radar: animated SVG showing nodes, latency rings, and gateway swaps
 *   Right — Resource Pooling deploy flow: "how much power do you need?" sliders
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Cpu, MemoryStick, HardDrive, Wifi, Zap, Globe,
  Loader2, CheckCircle, AlertCircle, Play, Radio,
} from 'lucide-react';
import api from '../services/api';
import { io, Socket } from 'socket.io-client';
import { Card, CardHeader } from '../components/ui/Card';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SonarNode {
  nodeId:    string;
  name:      string;
  country:   string | null;
  state:     string | null;
  continent: string | null;
  latencyMs: number | null;
  status:    string;
  isGateway: boolean;
  meshIp?:   string;
  angle?:    number; // computed for radar placement
  radius?:   number;
}

interface GatewaySwapEvent {
  appId:     string;
  from:      string | null;
  to:        string;
  toName:    string;
  toCountry: string | null;
  tier:      string;
  latencyMs: number | null;
  ts:        number;
}

// ── Sonar Radar SVG ───────────────────────────────────────────────────────────

const CX = 200, CY = 200, R = 160;
const RING_RADII = [40, 80, 120, 160];
const RING_LABELS = ['<20ms', '<60ms', '<120ms', 'global'];

function latencyToRadius(ms: number | null): number {
  if (ms === null) return R;
  if (ms < 20)  return RING_RADII[0];
  if (ms < 60)  return RING_RADII[1];
  if (ms < 120) return RING_RADII[2];
  return RING_RADII[3];
}

function SonarRadar({ nodes, swapEvents }: { nodes: SonarNode[]; swapEvents: GatewaySwapEvent[] }) {
  const [scanAngle, setScanAngle] = useState(0);
  const [pulseScale, setPulseScale] = useState(1);

  // Scan beam animation
  useEffect(() => {
    let frame: number;
    let last = performance.now();
    const animate = (now: number) => {
      const dt = now - last; last = now;
      setScanAngle(a => (a + dt * 0.06) % 360);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, []);

  // Pulse on swap
  useEffect(() => {
    if (swapEvents.length === 0) return;
    setPulseScale(1.4);
    const t = setTimeout(() => setPulseScale(1), 600);
    return () => clearTimeout(t);
  }, [swapEvents.length]);

  const scanRad = (scanAngle * Math.PI) / 180;

  return (
    <svg viewBox="0 0 400 400" className="w-full max-w-sm mx-auto select-none">
      {/* Dark background */}
      <circle cx={CX} cy={CY} r={R + 20} fill="#0a0a12" />

      {/* Concentric rings */}
      {RING_RADII.map((r, i) => (
        <g key={r}>
          <circle cx={CX} cy={CY} r={r} fill="none"
            stroke={i === 0 ? 'rgba(34,197,94,0.3)' : 'rgba(99,102,241,0.15)'}
            strokeWidth={i === 0 ? 1.5 : 1} strokeDasharray={i > 0 ? '4 4' : undefined}/>
          <text x={CX + r + 3} y={CY - 3} fontSize="7" fill="rgba(255,255,255,0.25)">{RING_LABELS[i]}</text>
        </g>
      ))}

      {/* Cross-hairs */}
      <line x1={CX - R} y1={CY} x2={CX + R} y2={CY} stroke="rgba(255,255,255,0.08)" strokeWidth="1"/>
      <line x1={CX} y1={CY - R} x2={CX} y2={CY + R} stroke="rgba(255,255,255,0.08)" strokeWidth="1"/>

      {/* Rotating scan beam */}
      <defs>
        <radialGradient id="scan-grad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(99,102,241,0.0)"/>
          <stop offset="100%" stopColor="rgba(99,102,241,0.25)"/>
        </radialGradient>
      </defs>
      <path
        d={`M ${CX} ${CY} L ${CX + R * Math.cos(scanRad - 0.3)} ${CY + R * Math.sin(scanRad - 0.3)} A ${R} ${R} 0 0 1 ${CX + R * Math.cos(scanRad)} ${CY + R * Math.sin(scanRad)} Z`}
        fill="rgba(99,102,241,0.15)"
      />
      <line
        x1={CX} y1={CY}
        x2={CX + R * Math.cos(scanRad)} y2={CY + R * Math.sin(scanRad)}
        stroke="rgba(99,102,241,0.7)" strokeWidth="1.5"
      />

      {/* Nodes */}
      {nodes.map((node, i) => {
        const angle = node.angle ?? (i / Math.max(nodes.length, 1)) * 2 * Math.PI;
        const rad   = node.radius ?? latencyToRadius(node.latencyMs);
        const nx = CX + rad * Math.cos(angle);
        const ny = CY + rad * Math.sin(angle);
        const isOnline = node.status === 'ONLINE';
        const color = node.isGateway ? '#22c55e' : (isOnline ? '#6366f1' : '#6b7280');
        const r = node.isGateway ? 7 : 5;

        return (
          <g key={node.nodeId}>
            {node.isGateway && (
              <circle cx={nx} cy={ny} r={r * pulseScale * 2.5} fill={color} opacity="0.2"
                style={{ transition: 'r 0.3s ease' }}/>
            )}
            <circle cx={nx} cy={ny} r={r} fill={color} opacity={isOnline ? 0.95 : 0.4}/>
            {node.latencyMs !== null && (
              <text x={nx + 8} y={ny + 4} fontSize="8" fill="rgba(255,255,255,0.7)">
                {node.latencyMs.toFixed(0)}ms
              </text>
            )}
            <text x={nx} y={ny + r + 10} fontSize="7" fill="rgba(255,255,255,0.5)"
              textAnchor="middle" className="pointer-events-none">
              {node.name.slice(0, 8)}
            </text>
          </g>
        );
      })}

      {/* Center dot (master) */}
      <circle cx={CX} cy={CY} r={6} fill="#f59e0b"/>
      <text x={CX} y={CY + 18} fontSize="8" fill="#f59e0b" textAnchor="middle">MASTER</text>
    </svg>
  );
}

// ── Resource Pooling Sliders ──────────────────────────────────────────────────

function PoolingSlider({ label, icon, value, min, max, step, unit, onChange }: {
  label: string; icon: React.ReactNode; value: number;
  min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[13px] text-text-secondary">
          <span className="text-text-muted">{icon}</span>{label}
        </div>
        <span className={`font-bold transition-all duration-150 ${dragging ? 'text-[18px] text-accent' : 'text-[14px] text-text-primary'}`}>
          {value.toLocaleString()}{unit}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onMouseDown={() => setDragging(true)} onMouseUp={() => setDragging(false)}
        onTouchStart={() => setDragging(true)} onTouchEnd={() => setDragging(false)}
        onChange={e => onChange(Number(e.target.value))}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        className="w-full h-2 rounded-full appearance-none cursor-pointer
          [background:linear-gradient(to_right,#6366f1_var(--pct),rgba(255,255,255,0.08)_var(--pct))]
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
          [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:cursor-pointer
          [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-0"
      />
      <div className="flex justify-between text-[11px] text-text-muted">
        <span>{min.toLocaleString()}{unit}</span>
        <span className="text-text-muted">{Math.round(pct)}% do máximo</span>
        <span>{max.toLocaleString()}{unit}</span>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SonarRadarPage() {
  const navigate = useNavigate();
  const socketRef = useRef<Socket | null>(null);

  // Radar state
  const [nodes, setNodes] = useState<SonarNode[]>([]);
  const [swapEvents, setSwapEvents] = useState<GatewaySwapEvent[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(true);

  // Deploy form
  const [form, setForm] = useState({
    name:          '',
    slug:          '',
    executionMode: 'AUTO' as 'AUTO' | 'MICROVM' | 'WASM',
    totalCpuCores: 8,
    totalRamMb:    16384,
    totalVramMb:   0,
    maxNodes:      4,
  });
  const [deploying, setDeploying] = useState(false);
  const [deployed, setDeployed]   = useState(false);
  const [deployError, setDeployError] = useState('');
  const [deployResult, setDeployResult] = useState<any>(null);

  // Load online nodes for radar
  const loadNodes = useCallback(async () => {
    setLoadingNodes(true);
    try {
      const res = await api.get('/v1/agent/nodes');
      const raw: any[] = res.data.data.nodes ?? [];
      const mapped: SonarNode[] = raw.map((n, i) => {
        const angle  = (i / Math.max(raw.length, 1)) * 2 * Math.PI - Math.PI / 2;
        const radius = latencyToRadius(n.sonarLatencyMs ?? null);
        return {
          nodeId:    n.id,
          name:      n.name,
          country:   n.country,
          state:     n.state,
          continent: n.continent,
          latencyMs: n.sonarLatencyMs ?? null,
          status:    n.status,
          isGateway: n.transitStatus === 'STREAMING',
          meshIp:    n.meshIp,
          angle,
          radius,
        };
      });
      setNodes(mapped);
    } catch {
      setNodes([]);
    } finally {
      setLoadingNodes(false);
    }
  }, []);

  useEffect(() => {
    loadNodes();
    const interval = setInterval(loadNodes, 15_000);

    const socket = io(window.location.origin, {
      auth: { token: localStorage.getItem('token') },
    });
    socketRef.current = socket;

    socket.on('sonar:gateway_swap', (evt: GatewaySwapEvent) => {
      setSwapEvents(prev => [evt, ...prev.slice(0, 9)]);
      // Refresh nodes to show new gateway
      loadNodes();
    });

    return () => {
      clearInterval(interval);
      socket.disconnect();
    };
  }, [loadNodes]);

  const handleNameChange = (name: string) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    setForm(f => ({ ...f, name, slug }));
  };

  const handleDeploy = async () => {
    if (!form.name) return;
    setDeploying(true); setDeployError('');
    try {
      const res = await api.post('/v1/clusters/create', form);
      setDeployResult(res.data.data);
      setDeployed(true);
      setTimeout(() => navigate(`/depin/${res.data.data.app.id}`), 2000);
    } catch (err: any) {
      setDeployError(err.response?.data?.message ?? 'Erro ao criar cluster.');
    } finally {
      setDeploying(false);
    }
  };

  // Compute estimated node count needed
  const estNodes = Math.ceil(form.totalCpuCores / 4); // rough 4 vCPU per node

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Radio className="w-5 h-5 text-accent-light"/>
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Nexus Collective</h1>
          <p className="text-[13px] text-text-secondary">
            Supercomputador distribuído — defina o poder, o enxame cuida do resto.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Left: Sonar Radar ─────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Sonar — Mapa de Rede"
            description="Latência em ms dos nós online. Verde = gateway ativo."
            icon={<Globe className="w-4 h-4"/>}
          />
          <div className="mt-4">
            {loadingNodes ? (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="w-6 h-6 text-accent animate-spin"/>
              </div>
            ) : nodes.length === 0 ? (
              <div className="text-center py-16 text-text-muted text-[13px]">
                Nenhum nó online. Conecte um agente para começar.
              </div>
            ) : (
              <SonarRadar nodes={nodes} swapEvents={swapEvents}/>
            )}

            {/* Node legend */}
            <div className="mt-3 space-y-1 max-h-40 overflow-y-auto">
              {nodes.map(n => (
                <div key={n.nodeId} className="flex items-center justify-between px-2 py-1 rounded-lg hover:bg-white/[0.03] text-[12px]">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${n.isGateway ? 'bg-success' : n.status === 'ONLINE' ? 'bg-accent' : 'bg-text-muted'}`}/>
                    <span className="text-text-primary font-medium">{n.name}</span>
                    {n.isGateway && <span className="badge badge-success text-[10px]">GATEWAY</span>}
                  </div>
                  <div className="flex items-center gap-3 text-text-muted">
                    {n.country && <span>{n.country}{n.state ? `/${n.state}` : ''}</span>}
                    {n.latencyMs !== null ? (
                      <span className={`font-mono ${n.latencyMs < 20 ? 'text-success' : n.latencyMs < 60 ? 'text-warning' : 'text-danger'}`}>
                        {n.latencyMs.toFixed(0)}ms
                      </span>
                    ) : <span className="text-text-muted">—</span>}
                  </div>
                </div>
              ))}
            </div>

            {/* Swap events feed */}
            {swapEvents.length > 0 && (
              <div className="mt-3 space-y-1">
                <p className="text-[11px] font-semibold text-text-muted uppercase tracking-widest mb-1">Trocas de gateway</p>
                {swapEvents.slice(0, 3).map((e, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1 rounded-lg bg-success/5 border border-success/20 text-[11px]">
                    <Zap className="w-3 h-3 text-success shrink-0"/>
                    <span className="text-text-secondary">
                      {e.toName} ativado · tier={e.tier}
                      {e.latencyMs !== null && ` · ${e.latencyMs.toFixed(0)}ms`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* ── Right: Resource Pooling Deploy ───────────────────────── */}
        <Card>
          <CardHeader
            title="Novo Deploy Coletivo"
            description="Defina o poder total — o Nexus distribui automaticamente entre os nós mais próximos."
            icon={<Cpu className="w-4 h-4"/>}
          />
          <div className="mt-4 space-y-5">
            {deployError && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-danger/10 border border-danger/20 text-danger text-sm">
                <AlertCircle className="w-4 h-4 shrink-0"/>{deployError}
              </div>
            )}

            {deployed && deployResult && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-success/10 border border-success/20 text-success text-sm">
                <CheckCircle className="w-4 h-4 shrink-0"/>
                Cluster criado: {deployResult.cluster.nodeCount} nós · {deployResult.cluster.totalCpuCores} vCPUs · {Math.round(deployResult.cluster.totalRamMb/1024)} GB RAM
              </div>
            )}

            {/* App name */}
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">Nome do app</label>
              <input
                className="input-field"
                placeholder="meu-llm-cluster"
                value={form.name}
                onChange={e => handleNameChange(e.target.value)}
              />
            </div>

            {/* Execution mode */}
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">Modo de execução</label>
              <div className="grid grid-cols-3 gap-2">
                {(['AUTO', 'MICROVM', 'WASM'] as const).map(m => (
                  <button key={m} onClick={() => setForm(f => ({ ...f, executionMode: m }))}
                    className={`py-2 rounded-xl text-[12px] font-semibold border transition-colors ${form.executionMode === m ? 'bg-accent/20 border-accent/40 text-accent' : 'bg-white/[0.04] border-white/[0.06] text-text-muted hover:border-white/10'}`}>
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-white/[0.06] pt-4 space-y-4">
              <p className="text-[12px] font-semibold text-text-muted uppercase tracking-widest">Poder total necessário</p>

              <PoolingSlider label="vCPUs" icon={<Cpu className="w-3.5 h-3.5"/>}
                value={form.totalCpuCores} min={1} max={256} step={1} unit=" vCPUs"
                onChange={v => setForm(f => ({ ...f, totalCpuCores: v }))}/>

              <PoolingSlider label="RAM" icon={<MemoryStick className="w-3.5 h-3.5"/>}
                value={form.totalRamMb} min={512} max={524288} step={512} unit=" MB"
                onChange={v => setForm(f => ({ ...f, totalRamMb: v }))}/>

              <PoolingSlider label="VRAM (GPU)" icon={<HardDrive className="w-3.5 h-3.5"/>}
                value={form.totalVramMb} min={0} max={819200} step={1024} unit=" MB"
                onChange={v => setForm(f => ({ ...f, totalVramMb: v }))}/>

              <PoolingSlider label="Nós máximos" icon={<Wifi className="w-3.5 h-3.5"/>}
                value={form.maxNodes} min={1} max={32} step={1} unit=" nós"
                onChange={v => setForm(f => ({ ...f, maxNodes: v }))}/>
            </div>

            {/* Summary */}
            <div className="p-3 rounded-xl bg-accent/5 border border-accent/20 text-[12px] text-text-secondary space-y-1">
              <p>~{estNodes} nó{estNodes !== 1 ? 's' : ''} estimado{estNodes !== 1 ? 's' : ''} · nó mais próximo selecionado primeiro</p>
              {form.totalVramMb > 0 && <p className="text-[#a5b4fc]">GPU: {(form.totalVramMb/1024).toFixed(0)} GB VRAM total via mesh WireGuard</p>}
              <p className="text-text-muted">Subnet mesh: 10.50.0.0/24 · NCCL via nexus0</p>
            </div>

            <button onClick={handleDeploy} disabled={deploying || deployed || !form.name}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-accent hover:bg-accent-light disabled:opacity-50 text-white font-semibold transition-colors">
              {deployed   ? <><CheckCircle className="w-4 h-4"/>Cluster criado!</>
               : deploying ? <><Loader2 className="w-4 h-4 animate-spin"/>Alocando nós…</>
               :             <><Play className="w-4 h-4"/>Lançar supercomputador</>}
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
