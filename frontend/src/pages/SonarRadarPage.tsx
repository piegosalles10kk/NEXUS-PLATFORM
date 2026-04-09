/**
 * SonarRadarPage.tsx  (Sprint 17.2 — Organic Constellation)
 *
 * Two panels:
 *   Left  — Organic Constellation: canvas force-graph with drift/join animations
 *           • CLIENT VIEW: star codenames (Orion, Sirius…), IPs hidden
 *           • ADMIN VIEW: real IPs and hostnames (only if role === ADM)
 *   Right — Resource Pooling deploy flow (unchanged)
 *
 * Edge colors:
 *   🟢 #22c55e — GPU-capable link
 *   🟡 #f59e0b — CPU-heavy link
 *   🔵 #6366f1 — Network/mesh link
 *   🔴 #ef4444 — Failed/degraded node
 *
 * "Drift Away" animation: node opacity → 0, position drifts outward
 * "Organic Join" animation: node pulses from 0 → full size and snaps into graph
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Cpu, MemoryStick, HardDrive, Wifi, Zap, Globe,
  Loader2, CheckCircle, AlertCircle, Play, Radio,
  Star, Eye, EyeOff,
} from 'lucide-react';
import api from '../services/api';
import { io, Socket } from 'socket.io-client';
import { Card, CardHeader } from '../components/ui/Card';
import { useAuth } from '../contexts/AuthContext';

// ── Star codenames (client view) ──────────────────────────────────────────────
const STAR_NAMES = [
  'Orion','Sirius','Vega','Rigel','Deneb','Altair','Arcturus','Aldebaran',
  'Antares','Spica','Pollux','Castor','Capella','Procyon','Regulus','Betelgeuse',
  'Fomalhaut','Achernar','Mira','Canopus','Hadar','Acrux','Mimosa','Gacrux',
  'Elnath','Alhena','Adhara','Wezen','Mirfak','Algenib','Algol','Menkar',
  'Menkib','Nunki','Kaus','Sabik','Rasalhague','Yed','Cebalrai','Marfik',
  'Zubenelgenubi','Zubeneshamali','Sheratan','Hamal','Menkar','Miram',
  'Segin','Ruchbah','Caph','Schedar','Navi','Achird','Fulu','Phi',
  'Dubhe','Merak','Phad','Megrez','Alioth','Mizar','Alkaid','Thuban',
];

function starName(nodeId: string): string {
  // deterministic from first 4 hex chars of uuid
  const hex = nodeId.replace(/-/g, '').slice(0, 4);
  const idx = parseInt(hex, 16) % STAR_NAMES.length;
  return STAR_NAMES[idx];
}

// ── Force-graph types ─────────────────────────────────────────────────────────

interface FNode {
  nodeId:    string;
  label:     string;    // codename or real hostname
  ip:        string | null;
  status:    'ONLINE' | 'OFFLINE' | string;
  isGateway: boolean;
  hasGpu:    boolean;
  latencyMs: number | null;
  // physics
  x: number; y: number;
  vx: number; vy: number;
  // animation
  opacity:  number;  // 0-1 (drift-away: decreasing)
  scale:    number;  // 0-2 (organic-join: pulse)
  drifting: boolean; // true = fade out + move away
  joining:  boolean; // true = pulse in animation
}

interface FEdge {
  from: string; // nodeId
  to:   string;
  type: 'gpu' | 'cpu' | 'net' | 'fail';
}

// ── Canvas force-graph ────────────────────────────────────────────────────────

const CANVAS_W = 520;
const CANVAS_H = 400;
const CENTER_X = CANVAS_W / 2;
const CENTER_Y = CANVAS_H / 2;

// Physics constants
const REPULSION   = 3500;
const SPRING_LEN  = 120;
const SPRING_K    = 0.04;
const DAMPING     = 0.85;
const CENTER_PULL = 0.02;

function edgeColor(type: FEdge['type']): string {
  switch (type) {
    case 'gpu':  return 'rgba(34,197,94,0.5)';
    case 'cpu':  return 'rgba(245,158,11,0.4)';
    case 'fail': return 'rgba(239,68,68,0.6)';
    default:     return 'rgba(99,102,241,0.35)';
  }
}

function useForceGraph(nodes: FNode[], edges: FEdge[]) {
  const nodesRef = useRef<FNode[]>([]);
  const edgesRef = useRef<FEdge[]>(edges);
  const frameRef = useRef<number>(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Sync node changes (drift-away removed, organic-join new)
  useEffect(() => {
    const prev = nodesRef.current;
    const prevIds = new Set(prev.map(n => n.nodeId));
    const newIds  = new Set(nodes.map(n => n.nodeId));

    // Mark removed nodes as drifting (keep for animation)
    const drifting = prev
      .filter(n => !newIds.has(n.nodeId))
      .map(n => ({ ...n, drifting: true }));

    // New nodes get joining animation
    const joined = nodes.map(n => {
      const existing = prev.find(p => p.nodeId === n.nodeId);
      if (existing) return { ...existing, ...n }; // preserve physics state
      // Spawn at random edge of canvas
      const angle = Math.random() * 2 * Math.PI;
      return {
        ...n,
        x: CENTER_X + Math.cos(angle) * 250,
        y: CENTER_Y + Math.sin(angle) * 200,
        vx: 0, vy: 0,
        opacity: 0,
        scale: 2,
        drifting: false,
        joining: true,
      };
    });

    nodesRef.current = [...drifting, ...joined];
    edgesRef.current = edges;
  }, [nodes, edges]);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const tick = () => {
      // Physics step
      const ns = nodesRef.current;
      const es = edgesRef.current;

      // Repulsion
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const dx = ns[j].x - ns[i].x;
          const dy = ns[j].y - ns[i].y;
          const dist2 = dx * dx + dy * dy + 1;
          const force = REPULSION / dist2;
          const nx = dx / Math.sqrt(dist2);
          const ny = dy / Math.sqrt(dist2);
          ns[i].vx -= nx * force;
          ns[i].vy -= ny * force;
          ns[j].vx += nx * force;
          ns[j].vy += ny * force;
        }
      }

      // Springs (edges)
      for (const e of es) {
        const a = ns.find(n => n.nodeId === e.from);
        const b = ns.find(n => n.nodeId === e.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const stretch = (dist - SPRING_LEN) * SPRING_K;
        const fx = (dx / dist) * stretch;
        const fy = (dy / dist) * stretch;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }

      // Center pull + damping + integrate
      for (const n of ns) {
        n.vx += (CENTER_X - n.x) * CENTER_PULL;
        n.vy += (CENTER_Y - n.y) * CENTER_PULL;
        n.vx *= DAMPING;
        n.vy *= DAMPING;

        if (n.drifting) {
          // Drift away from center
          const cx = n.x - CENTER_X;
          const cy = n.y - CENTER_Y;
          const len = Math.sqrt(cx * cx + cy * cy) || 1;
          n.vx += (cx / len) * 1.5;
          n.vy += (cy / len) * 1.5;
          n.opacity = Math.max(0, n.opacity - 0.018);
        } else if (n.joining) {
          n.opacity = Math.min(1, n.opacity + 0.06);
          n.scale   = Math.max(1, n.scale - 0.07);
          if (n.opacity >= 1 && n.scale <= 1.05) n.joining = false;
        } else {
          n.opacity = Math.min(1, n.opacity + 0.05);
          n.scale = 1;
        }

        n.x += n.vx;
        n.y += n.vy;

        // Boundary bounce
        const pad = 30;
        if (n.x < pad)         { n.x = pad;         n.vx = Math.abs(n.vx) * 0.5; }
        if (n.x > CANVAS_W-pad){ n.x = CANVAS_W-pad; n.vx = -Math.abs(n.vx) * 0.5; }
        if (n.y < pad)         { n.y = pad;          n.vy = Math.abs(n.vy) * 0.5; }
        if (n.y > CANVAS_H-pad){ n.y = CANVAS_H-pad; n.vy = -Math.abs(n.vy) * 0.5; }
      }

      // Remove fully drifted nodes
      nodesRef.current = ns.filter(n => !n.drifting || n.opacity > 0);

      // Render
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

      // Background
      ctx.fillStyle = '#080810';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      // Starfield
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      for (let i = 0; i < 60; i++) {
        const bx = (Math.sin(i * 137.5) * 0.5 + 0.5) * CANVAS_W;
        const by = (Math.cos(i * 97.3) * 0.5 + 0.5) * CANVAS_H;
        ctx.beginPath();
        ctx.arc(bx, by, 0.7, 0, Math.PI * 2);
        ctx.fill();
      }

      // Edges
      for (const e of es) {
        const a = nodesRef.current.find(n => n.nodeId === e.from);
        const b = nodesRef.current.find(n => n.nodeId === e.to);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = edgeColor(e.type);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Nodes
      for (const n of nodesRef.current) {
        const r = (n.isGateway ? 10 : 7) * n.scale;
        const color = n.status !== 'ONLINE'
          ? '#ef4444'
          : n.isGateway ? '#22c55e'
          : n.hasGpu    ? '#a78bfa'
          :                '#6366f1';

        ctx.globalAlpha = n.opacity;

        // Joining pulse ring
        if (n.joining && n.scale > 1.1) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r * 2, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.globalAlpha = n.opacity * 0.3;
          ctx.stroke();
          ctx.globalAlpha = n.opacity;
        }

        // Glow
        if (n.isGateway) {
          const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3);
          grad.addColorStop(0, 'rgba(34,197,94,0.25)');
          grad.addColorStop(1, 'rgba(34,197,94,0)');
          ctx.beginPath();
          ctx.arc(n.x, n.y, r * 3, 0, Math.PI * 2);
          ctx.fillStyle = grad;
          ctx.fill();
        }

        // Node circle
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        // Label
        ctx.globalAlpha = n.opacity * 0.85;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(n.label, n.x, n.y + r + 12);

        if (n.latencyMs !== null && n.opacity > 0.5) {
          ctx.font = '8px monospace';
          ctx.fillStyle = n.latencyMs < 20 ? '#22c55e' : n.latencyMs < 60 ? '#f59e0b' : '#ef4444';
          ctx.fillText(`${n.latencyMs.toFixed(0)}ms`, n.x, n.y + r + 22);
        }

        ctx.globalAlpha = 1;
      }

      // Master node at center
      ctx.beginPath();
      ctx.arc(CENTER_X, CENTER_Y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#f59e0b';
      ctx.fill();
      ctx.fillStyle = 'rgba(245,158,11,0.8)';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('MASTER', CENTER_X, CENTER_Y + 18);

      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, []); // only run once — data is via refs

  return canvasRef;
}

// ── Constellation component ───────────────────────────────────────────────────

function OrganicConstellation({ nodes, edges, isAdmin }: {
  nodes: FNode[]; edges: FEdge[]; isAdmin: boolean;
}) {
  const canvasRef = useForceGraph(nodes, edges);
  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        style={{ width: '100%', borderRadius: '12px' }}
      />
      {!isAdmin && (
        <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/60 border border-white/10 text-[10px] text-text-muted">
          <EyeOff className="w-3 h-3"/>Sigilo estelar ativo
        </div>
      )}
    </div>
  );
}

// ── Resource Pooling Slider ───────────────────────────────────────────────────

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

// ── Raw SonarNode type ────────────────────────────────────────────────────────

interface SonarNode {
  nodeId:    string;
  name:      string;
  country:   string | null;
  latencyMs: number | null;
  status:    string;
  isGateway: boolean;
  meshIp?:   string;
  gpuCount?: number;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SonarRadarPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADM';
  const socketRef = useRef<Socket | null>(null);

  const [rawNodes, setRawNodes]     = useState<SonarNode[]>([]);
  const [loadingNodes, setLoading]  = useState(true);
  const [showMasked, setShowMasked] = useState(!isAdmin);

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
  const [deploying, setDeploying]     = useState(false);
  const [deployed, setDeployed]       = useState(false);
  const [deployError, setDeployError] = useState('');
  const [deployResult, setDeployResult] = useState<any>(null);

  const loadNodes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/v1/agent/nodes');
      const raw: any[] = res.data.data.nodes ?? [];
      const mapped: SonarNode[] = raw.map(n => ({
        nodeId:    n.id,
        name:      n.name,
        country:   n.country,
        latencyMs: n.sonarLatencyMs ?? null,
        status:    n.status,
        isGateway: n.transitStatus === 'STREAMING',
        meshIp:    n.meshIp,
        gpuCount:  n.gpuCount ?? 0,
      }));
      setRawNodes(mapped);
    } catch {
      setRawNodes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNodes();
    const interval = setInterval(loadNodes, 15_000);

    const socket = io(window.location.origin, {
      auth: { token: localStorage.getItem('token') },
    });
    socketRef.current = socket;

    socket.on('node:metrics', () => { /* real-time latency update */ });
    socket.on('sonar:gateway_swap', () => loadNodes());

    return () => { clearInterval(interval); socket.disconnect(); };
  }, [loadNodes]);

  // Build force-graph nodes + edges from rawNodes
  const fNodes: FNode[] = rawNodes.map(n => ({
    nodeId:    n.nodeId,
    label:     showMasked ? starName(n.nodeId) : n.name,
    ip:        showMasked ? null : (n.meshIp ?? null),
    status:    n.status,
    isGateway: n.isGateway,
    hasGpu:    (n.gpuCount ?? 0) > 0,
    latencyMs: n.latencyMs,
    x: CANVAS_W / 2 + (Math.random() - 0.5) * 200,
    y: CANVAS_H / 2 + (Math.random() - 0.5) * 150,
    vx: 0, vy: 0,
    opacity: 0,
    scale: 1.8,
    drifting: false,
    joining: true,
  }));

  // Edges: mesh IPs connected to gateway, CPU-heavy nodes connected to each other
  const fEdges: FEdge[] = [];
  const onlineNodes = rawNodes.filter(n => n.status === 'ONLINE');
  const gateway = onlineNodes.find(n => n.isGateway);
  for (const n of onlineNodes) {
    if (gateway && n.nodeId !== gateway.nodeId) {
      fEdges.push({
        from: gateway.nodeId,
        to:   n.nodeId,
        type: n.status !== 'ONLINE' ? 'fail'
            : (n.gpuCount ?? 0) > 0 ? 'gpu'
            : 'net',
      });
    }
  }

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

  const estNodes = Math.ceil(form.totalCpuCores / 4);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Radio className="w-5 h-5 text-accent-light"/>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Nexus Collective</h1>
            <p className="text-[13px] text-text-secondary">
              Organic Constellation — enxame distribuído auto-curativo.
            </p>
          </div>
        </div>

        {isAdmin && (
          <button
            onClick={() => setShowMasked(m => !m)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-[12px] text-text-secondary hover:text-text-primary transition-colors"
          >
            {showMasked ? <><Eye className="w-3.5 h-3.5"/>Revelar IPs</> : <><EyeOff className="w-3.5 h-3.5"/>Modo Sigilo</>}
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Left: Organic Constellation ──────────────────────────── */}
        <Card>
          <CardHeader
            title={showMasked ? 'Organic Constellation' : 'Nexus Net — Visão Global'}
            description={showMasked
              ? 'Topologia da rede com identidade blindada. Nós têm codinomes estelares.'
              : 'Mapa completo da rede com IPs e hostnames reais.'}
            icon={showMasked ? <Star className="w-4 h-4"/> : <Globe className="w-4 h-4"/>}
          />
          <div className="mt-3">
            {loadingNodes ? (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="w-6 h-6 text-accent animate-spin"/>
              </div>
            ) : rawNodes.length === 0 ? (
              <div className="text-center py-16 text-text-muted text-[13px]">
                Nenhum nó online. Conecte um agente para começar.
              </div>
            ) : (
              <OrganicConstellation nodes={fNodes} edges={fEdges} isAdmin={isAdmin && !showMasked}/>
            )}

            {/* Legend */}
            <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-text-muted">
              <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-[#22c55e]"/>GPU</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-[#6366f1]"/>CPU</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-[#a78bfa]"/>GPU node</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-[#ef4444]"/>Falha</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-[#f59e0b]"/>Master</span>
            </div>

            {/* Node list (masked or real) */}
            <div className="mt-3 max-h-36 overflow-y-auto space-y-0.5">
              {rawNodes.map(n => (
                <div key={n.nodeId} className="flex items-center justify-between px-2 py-1 rounded-md hover:bg-white/[0.03] text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${n.status === 'ONLINE' ? (n.isGateway ? 'bg-success' : 'bg-accent') : 'bg-danger'}`}/>
                    <span className="text-text-primary font-medium font-mono">
                      {showMasked ? starName(n.nodeId) : n.name}
                    </span>
                    {n.isGateway && <span className="text-[9px] px-1 py-0.5 rounded bg-success/20 text-success">GW</span>}
                    {!showMasked && n.meshIp && (
                      <span className="text-text-muted font-mono text-[10px]">{n.meshIp}</span>
                    )}
                  </div>
                  {n.latencyMs !== null && (
                    <span className={`font-mono text-[11px] ${n.latencyMs < 20 ? 'text-success' : n.latencyMs < 60 ? 'text-warning' : 'text-danger'}`}>
                      {n.latencyMs.toFixed(0)}ms
                    </span>
                  )}
                </div>
              ))}
            </div>
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

            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">Nome do app</label>
              <input
                className="input-field"
                placeholder="meu-llm-cluster"
                value={form.name}
                onChange={e => handleNameChange(e.target.value)}
              />
            </div>

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

            <div className="p-3 rounded-xl bg-accent/5 border border-accent/20 text-[12px] text-text-secondary space-y-1">
              <p>~{estNodes} nó{estNodes !== 1 ? 's' : ''} estimado{estNodes !== 1 ? 's' : ''} · nó mais próximo primeiro</p>
              {form.totalVramMb > 0 && <p className="text-[#a5b4fc]">GPU: {(form.totalVramMb/1024).toFixed(0)} GB VRAM via mesh WireGuard</p>}
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
