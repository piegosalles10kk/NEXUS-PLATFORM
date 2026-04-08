import { useState, useEffect, useCallback } from 'react';
import {
  Cpu, MemoryStick, HardDrive, Wifi, Clock,
  Server, Loader2, RefreshCw, Save, CheckCircle, AlertCircle,
  TrendingUp, Zap, Award, Activity, ChevronRight,
  ArrowUp, ArrowDown,
} from 'lucide-react';
import api from '../services/api';
import { getSocket, connectSocket } from '../services/socket';
import { Card, CardHeader, CardDivider } from '../components/ui/Card';

/* ── Types ─────────────────────────────────────────────────────── */
interface GPUInfo {
  name: string;
  memory_total_mb: number;
  memory_used_mb?: number;
  utilization_percent?: number;
  driver_version?: string;
}

interface NodePolicy {
  maxCpuPercent:    number;
  maxRamMb:         number;
  maxDiskGb:        number;
  maxBandwidthMbps: number;
  scheduleStart:    string;
  scheduleEnd:      string;
  offerGpu:         boolean;
  maxGpuPercent:    number;
}

interface ProviderNode {
  id: string;
  name: string;
  status: string;
  country?: string;
  city?: string;
  ipAddress?: string;
  gpuModel?: string;
  gpuMemoryMb?: number;
  gpuCount?: number;
  policy?: NodePolicy | null;
  _count?: { assignments: number };
}

interface TelemetryPayload {
  timestamp: number;
  cpuUsage:  number;
  ramUsage:  number;
  ramTotal:  number;
  ramUsed:   number;
  diskUsage: number;
  diskTotal: number;
  diskUsed:  number;
  netTxSec:  number;
  netRxSec:  number;
  topProcs?: { pid: number; name: string; cpu: number; ram: number }[];
  gpus?:     GPUInfo[];
}

/* ── Helpers ──────────────────────────────────────────────────── */
function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB/s`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB/s`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB/s`;
  return `${b} B/s`;
}

function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

/* ── Power Rank ─────────────────────────────────────────────────── */
interface RankInfo {
  rank: 'Bronze' | 'Silver' | 'Gold' | 'Platinum';
  color: string;
  bg: string;
  border: string;
  score: number;
}

function getPowerRank(p: NodePolicy, hasGpu: boolean): RankInfo {
  const gpuBonus = hasGpu && p.offerGpu ? 15 : 0;
  const score =
    (p.maxCpuPercent / 100) * 45 +
    (p.maxRamMb / 32768) * 25 +
    (p.maxBandwidthMbps / 10000) * 15 +
    gpuBonus;

  if (score >= 75) return { rank: 'Platinum', color: 'text-[#b8c7ff]', bg: 'bg-[#b8c7ff]/10', border: 'border-[#b8c7ff]/30', score };
  if (score >= 50) return { rank: 'Gold',     color: 'text-[#ffd700]', bg: 'bg-[#ffd700]/10', border: 'border-[#ffd700]/30', score };
  if (score >= 25) return { rank: 'Silver',   color: 'text-[#c8d0e0]', bg: 'bg-[#c8d0e0]/10', border: 'border-[#c8d0e0]/30', score };
  return              { rank: 'Bronze',   color: 'text-[#cd9f6a]', bg: 'bg-[#cd9f6a]/10', border: 'border-[#cd9f6a]/30', score };
}

/* ── Earnings preview ───────────────────────────────────────────── */
function calcMonthlyEarnings(p: NodePolicy, surge: number, hasGpu: boolean): number {
  const gpuBonus = hasGpu && p.offerGpu ? 0.80 : 0;
  const hourlyBase =
    (p.maxCpuPercent / 100) * 0.50 +
    (p.maxRamMb / 32768) * 0.30 +
    (p.maxBandwidthMbps / 10000) * 0.20 +
    gpuBonus;
  const powerScore =
    (p.maxCpuPercent / 100) * 45 +
    (p.maxRamMb / 32768) * 25 +
    (p.maxBandwidthMbps / 10000) * 15 +
    (hasGpu && p.offerGpu ? 15 : 0);
  const powerFactor = 0.5 + (powerScore / 100) * 0.5;
  return hourlyBase * surge * powerFactor * 24 * 30;
}

/* ── Gauge Component ─────────────────────────────────────────────── */
function Gauge({ value, label, color = '#6366f1', icon }: {
  value: number;
  label: string;
  color?: string;
  icon: React.ReactNode;
}) {
  const clampedVal = Math.min(100, Math.max(0, value));
  const r = 26;
  const circ = 2 * Math.PI * r;
  const dash = (clampedVal / 100) * circ;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative w-16 h-16">
        <svg viewBox="0 0 60 60" className="w-full h-full -rotate-90">
          <circle cx="30" cy="30" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
          <circle
            cx="30" cy="30" r={r}
            fill="none"
            stroke={color}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ - dash}`}
            style={{ transition: 'stroke-dasharray 0.4s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-white/60">
          {icon}
        </div>
      </div>
      <p className="text-[15px] font-bold text-text-primary leading-none">{clampedVal.toFixed(0)}%</p>
      <p className="text-[11px] text-text-muted">{label}</p>
    </div>
  );
}

/* ── MiniBar ─────────────────────────────────────────────────────── */
function MiniBar({ value, color = 'bg-accent' }: { value: number; color?: string }) {
  return (
    <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
      <div
        className={`h-full ${color} rounded-full transition-all duration-300`}
        style={{ width: `${Math.min(100, value)}%` }}
      />
    </div>
  );
}

/* ── Live Telemetry Panel ────────────────────────────────────────── */
function LiveTelemetryPanel({ nodeId }: { nodeId: string }) {
  const [live, setLive] = useState<TelemetryPayload | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = getSocket();
    connectSocket();

    const handler = (data: { nodeId: string; data: TelemetryPayload }) => {
      if (data.nodeId === nodeId) setLive(data.data);
    };

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('node:telemetry', handler);

    if (socket.connected) setConnected(true);

    return () => {
      socket.off('node:telemetry', handler);
    };
  }, [nodeId]);

  if (!live) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3 text-text-muted">
        <Activity className="w-8 h-8 animate-pulse" />
        <p className="text-[13px]">
          {connected ? 'Aguardando dados de telemetria…' : 'Conectando ao WebSocket…'}
        </p>
      </div>
    );
  }

  const gpus = live.gpus ?? [];

  return (
    <div className="space-y-5">
      {/* Connection indicator */}
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-semibold text-text-secondary uppercase tracking-wider">Live Stats</p>
        <div className="flex items-center gap-1.5 text-[11px] text-success">
          <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
          Ao vivo
        </div>
      </div>

      {/* Gauges row */}
      <div className="grid grid-cols-4 gap-2">
        <Gauge value={live.cpuUsage} label="CPU" icon={<Cpu className="w-4 h-4" />} color="#6366f1" />
        <Gauge value={live.ramUsage} label="RAM" icon={<MemoryStick className="w-4 h-4" />} color="#22d3ee" />
        <Gauge value={live.diskUsage} label="Disco" icon={<HardDrive className="w-4 h-4" />} color="#f59e0b" />
        <Gauge
          value={gpus.length > 0 ? (gpus[0].utilization_percent ?? 0) : 0}
          label="GPU"
          icon={<Zap className="w-4 h-4" />}
          color={gpus.length > 0 ? '#a855f7' : '#374151'}
        />
      </div>

      {/* Detailed card */}
      <div className="grid grid-cols-2 gap-3">
        {/* RAM detail */}
        <div className="p-3 rounded-xl bg-white/[0.04] border border-white/[0.06] space-y-2">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-text-muted flex items-center gap-1"><MemoryStick className="w-3 h-3" /> RAM</span>
            <span className="text-text-primary font-semibold">{fmtMb(live.ramUsed / 1024 / 1024)} / {fmtMb(live.ramTotal / 1024 / 1024)}</span>
          </div>
          <MiniBar value={live.ramUsage} color="bg-cyan-400" />
        </div>

        {/* Network */}
        <div className="p-3 rounded-xl bg-white/[0.04] border border-white/[0.06] space-y-1">
          <p className="text-[12px] text-text-muted flex items-center gap-1"><Wifi className="w-3 h-3" /> Rede</p>
          <div className="flex items-center gap-2 text-[12px]">
            <ArrowUp className="w-3 h-3 text-emerald-400" />
            <span className="text-text-primary font-semibold">{fmtBytes(live.netTxSec)}</span>
          </div>
          <div className="flex items-center gap-2 text-[12px]">
            <ArrowDown className="w-3 h-3 text-blue-400" />
            <span className="text-text-primary font-semibold">{fmtBytes(live.netRxSec)}</span>
          </div>
        </div>
      </div>

      {/* GPU details (only if present) */}
      {gpus.length > 0 && (
        <div className="p-3 rounded-xl bg-purple-500/5 border border-purple-500/20 space-y-2">
          <p className="text-[12px] font-semibold text-purple-300 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5" /> GPU Detectada
          </p>
          {gpus.map((gpu, i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-text-secondary truncate max-w-[160px]">{gpu.name}</span>
                <span className="text-purple-300 font-semibold">{gpu.utilization_percent?.toFixed(0) ?? 0}%</span>
              </div>
              <MiniBar value={gpu.utilization_percent ?? 0} color="bg-purple-400" />
              <div className="flex justify-between text-[10px] text-text-muted">
                <span>VRAM: {fmtMb(gpu.memory_used_mb ?? 0)} / {fmtMb(gpu.memory_total_mb)}</span>
                {gpu.driver_version && <span>Driver {gpu.driver_version}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Top processes */}
      {(live.topProcs ?? []).length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">Top Processos</p>
          {(live.topProcs ?? []).slice(0, 5).map((p) => (
            <div key={p.pid} className="flex items-center justify-between text-[12px] py-1 border-b border-white/[0.04]">
              <span className="text-text-secondary truncate max-w-[140px]">{p.name}</span>
              <div className="flex gap-3 text-text-muted">
                <span className="text-accent font-mono">{p.cpu.toFixed(1)}% cpu</span>
                <span className="text-cyan-400 font-mono">{p.ram.toFixed(1)}% ram</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Enhanced PolicySlider ──────────────────────────────────────── */
function PolicySlider({
  label, icon, value, min, max, step, unit, onChange, disabled = false,
}: {
  label: string;
  icon: React.ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className={`p-4 rounded-xl bg-white/[0.04] backdrop-blur-md border border-white/[0.06] transition-all ${disabled ? 'opacity-40 pointer-events-none' : 'hover:border-white/10'}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-[13px] text-text-secondary">
          <span className="text-text-muted">{icon}</span>
          {label}
        </div>
        <span className={`font-bold transition-all duration-150 origin-right ${dragging ? 'text-[16px] text-accent scale-110' : 'text-[13px] text-text-primary scale-100'}`}>
          {value}{unit}
        </span>
      </div>

      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onMouseDown={() => setDragging(true)}
        onMouseUp={() => setDragging(false)}
        onTouchStart={() => setDragging(true)}
        onTouchEnd={() => setDragging(false)}
        onBlur={() => setDragging(false)}
        onChange={e => onChange(Number(e.target.value))}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        className="w-full h-2 rounded-full appearance-none cursor-pointer
          [background:linear-gradient(to_right,#6366f1_var(--pct),rgba(255,255,255,0.08)_var(--pct))]
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
          [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:cursor-pointer
          [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer"
      />

      <div className="flex justify-between text-[11px] text-text-muted mt-2">
        <span>{min}{unit}</span>
        <span className="text-[11px] text-text-muted/60">{Math.round(pct)}%</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  );
}

/* ── GPU Toggle Switch ──────────────────────────────────────────── */
function GpuToggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="p-4 rounded-xl bg-purple-500/5 border border-purple-500/20 flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <div className={`p-2 rounded-lg ${enabled ? 'bg-purple-500/20' : 'bg-white/[0.04]'} transition-colors`}>
          <Zap className={`w-4 h-4 ${enabled ? 'text-purple-400' : 'text-text-muted'}`} />
        </div>
        <div>
          <p className="text-[13px] font-semibold text-text-primary">Oferecer GPU</p>
          <p className="text-[11px] text-text-muted">+$0.80/h · bônus de rank</p>
        </div>
      </div>
      <button
        onClick={() => onChange(!enabled)}
        className={`relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${enabled ? 'bg-purple-500' : 'bg-white/10'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
      </button>
    </div>
  );
}

const DEFAULT_POLICY: NodePolicy = {
  maxCpuPercent:    80,
  maxRamMb:         2048,
  maxDiskGb:        20,
  maxBandwidthMbps: 100,
  scheduleStart:    '00:00',
  scheduleEnd:      '23:59',
  offerGpu:         false,
  maxGpuPercent:    100,
};

/* ── NodePolicyPanel ────────────────────────────────────────────── */
function NodePolicyPanel({
  node, surgeMultiplier, onSaved,
}: {
  node: ProviderNode;
  surgeMultiplier: number;
  onSaved: () => void;
}) {
  const [policy, setPolicy] = useState<NodePolicy>(node.policy ?? DEFAULT_POLICY);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'config' | 'telemetry'>('config');

  useEffect(() => {
    setPolicy(node.policy ?? DEFAULT_POLICY);
  }, [node.id]);

  const set = (key: keyof NodePolicy) => (v: number | string | boolean) =>
    setPolicy(p => ({ ...p, [key]: v }));

  const hasGpu = (node.gpuCount ?? 0) > 0;
  const rank = getPowerRank(policy, hasGpu);
  const monthly = calcMonthlyEarnings(policy, surgeMultiplier, hasGpu);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put(`/v1/agent/nodes/${node.id}/policy`, policy);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved();
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Erro ao salvar.');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      {/* Earnings + Rank row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-4 rounded-xl bg-success/5 border border-success/20">
          <div className="flex items-center gap-1.5 text-[12px] text-text-muted mb-1">
            <TrendingUp className="w-3.5 h-3.5 text-success" />
            Previsão mensal
          </div>
          <p className="text-[22px] font-bold text-success leading-none">
            ${monthly.toFixed(2)}
          </p>
          {surgeMultiplier > 1 && (
            <p className="text-[11px] text-text-muted mt-1 flex items-center gap-1">
              <Zap className="w-3 h-3 text-yellow-400" />
              surge {surgeMultiplier.toFixed(1)}×
            </p>
          )}
          {hasGpu && policy.offerGpu && (
            <p className="text-[11px] text-purple-400 mt-0.5 flex items-center gap-1">
              <Zap className="w-3 h-3" /> +GPU boost
            </p>
          )}
        </div>

        <div className={`p-4 rounded-xl border ${rank.bg} ${rank.border}`}>
          <div className="flex items-center gap-1.5 text-[12px] text-text-muted mb-1">
            <Award className="w-3.5 h-3.5" />
            Power Rank
          </div>
          <p className={`text-[22px] font-bold leading-none ${rank.color}`}>
            {rank.rank}
          </p>
          <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${rank.color.replace('text-', 'bg-')}`}
              style={{ width: `${Math.min(rank.score, 100)}%` }}
            />
          </div>
          <p className="text-[11px] text-text-muted mt-1">{rank.score.toFixed(0)} pts</p>
        </div>
      </div>

      {/* GPU hardware badge */}
      {hasGpu && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-300 text-[12px]">
          <Zap className="w-3.5 h-3.5 shrink-0" />
          <span><span className="font-semibold">{node.gpuModel ?? 'GPU detectada'}</span> · {node.gpuCount} GPU{(node.gpuCount ?? 0) > 1 ? 's' : ''} · {fmtMb(node.gpuMemoryMb ?? 0)} VRAM total</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-lg bg-white/[0.04] border border-white/[0.06]">
        {(['config', 'telemetry'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1.5 rounded-md text-[12px] font-semibold transition-all ${tab === t ? 'bg-accent text-white' : 'text-text-muted hover:text-text-secondary'}`}
          >
            {t === 'config' ? '⚙️ Configuração' : '📡 Telemetria Live'}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-danger/10 border border-danger/20 text-danger text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

      {tab === 'config' ? (
        <>
          {/* GPU Toggle */}
          <GpuToggle
            enabled={policy.offerGpu}
            onChange={set('offerGpu') as (v: boolean) => void}
          />

          {policy.offerGpu && hasGpu && (
            <PolicySlider
              label="Uso máximo de GPU"
              icon={<Zap className="w-3.5 h-3.5" />}
              value={policy.maxGpuPercent}
              min={10} max={100} step={5} unit="%"
              onChange={set('maxGpuPercent') as (v: number) => void}
            />
          )}

          {!hasGpu && policy.offerGpu && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-[12px]">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              Nenhuma GPU detectada neste nó ainda. O agente reportará GPUs quando conectado.
            </div>
          )}

          <CardDivider />

          <PolicySlider
            label="CPU máxima"
            icon={<Cpu className="w-3.5 h-3.5" />}
            value={policy.maxCpuPercent}
            min={10} max={100} step={5} unit="%"
            onChange={set('maxCpuPercent') as (v: number) => void}
          />
          <PolicySlider
            label="RAM máxima"
            icon={<MemoryStick className="w-3.5 h-3.5" />}
            value={policy.maxRamMb}
            min={256} max={32768} step={256} unit=" MB"
            onChange={set('maxRamMb') as (v: number) => void}
          />
          <PolicySlider
            label="Disco máximo"
            icon={<HardDrive className="w-3.5 h-3.5" />}
            value={policy.maxDiskGb}
            min={1} max={500} step={1} unit=" GB"
            onChange={set('maxDiskGb') as (v: number) => void}
          />
          <PolicySlider
            label="Banda máxima"
            icon={<Wifi className="w-3.5 h-3.5" />}
            value={policy.maxBandwidthMbps}
            min={1} max={10000} step={1} unit=" Mbps"
            onChange={set('maxBandwidthMbps') as (v: number) => void}
          />

          <CardDivider />

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="flex items-center gap-1 text-[12px] font-medium text-text-secondary mb-1.5">
                <Clock className="w-3.5 h-3.5" />Início (UTC)
              </label>
              <input
                type="time"
                value={policy.scheduleStart}
                onChange={e => setPolicy(p => ({ ...p, scheduleStart: e.target.value }))}
                className="input-field"
              />
            </div>
            <div>
              <label className="flex items-center gap-1 text-[12px] font-medium text-text-secondary mb-1.5">
                <Clock className="w-3.5 h-3.5" />Fim (UTC)
              </label>
              <input
                type="time"
                value={policy.scheduleEnd}
                onChange={e => setPolicy(p => ({ ...p, scheduleEnd: e.target.value }))}
                className="input-field"
              />
            </div>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-accent hover:bg-accent-light disabled:opacity-50 text-white text-sm font-semibold transition-colors"
          >
            {saved
              ? <><CheckCircle className="w-4 h-4" />Salvo!</>
              : saving
              ? <><Loader2 className="w-4 h-4 animate-spin" />Salvando…</>
              : <><Save className="w-4 h-4" />Salvar limites</>
            }
          </button>
        </>
      ) : (
        <LiveTelemetryPanel nodeId={node.id} />
      )}
    </div>
  );
}

/* ── Power Rank Badge (for node card) ─────────────────────────────── */
function PowerRankBadge({ policy, gpuCount }: { policy?: NodePolicy | null; gpuCount?: number }) {
  if (!policy) return null;
  const { rank, color, bg, border } = getPowerRank(policy, (gpuCount ?? 0) > 0);
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${bg} ${border} ${color}`}>
      <Award className="w-3 h-3" />{rank}
    </span>
  );
}

/* ── Page ──────────────────────────────────────────────────────────── */
export default function ProviderPage() {
  const [nodes, setNodes] = useState<ProviderNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [surgeMultiplier, setSurgeMultiplier] = useState(1.0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nodesRes, demandRes] = await Promise.allSettled([
        api.get('/v1/agent/nodes'),
        api.get('/depin/demand'),
      ]);
      if (nodesRes.status === 'fulfilled') setNodes(nodesRes.value.data.data.nodes);
      if (demandRes.status === 'fulfilled') {
        const ratio = demandRes.value.data.data.demandRatio as number;
        setSurgeMultiplier(Math.min(Math.max(1 + (ratio - 1) * 0.5, 1), 3));
      }
    } catch { setNodes([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const selectedNode = nodes.find(n => n.id === selected) ?? null;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Server className="w-5 h-5 text-accent-light" />
            <h1 className="text-2xl font-bold text-text-primary">Provedor de Hardware</h1>
          </div>
          <p className="text-[13px] text-text-secondary">
            Configure os limites dos seus nós e veja a telemetria em tempo real.
          </p>
        </div>
        <button onClick={load} className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-white/[0.04] transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 text-accent animate-spin" />
        </div>
      ) : nodes.length === 0 ? (
        <Card className="text-center py-20" padding="none">
          <Server className="w-10 h-10 text-text-muted mx-auto mb-4" />
          <p className="text-[14px] font-semibold text-text-primary mb-1">Nenhum nó registrado</p>
          <p className="text-[13px] text-text-secondary">Registre um nó em Cloud → Agentes para começar a ganhar.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Node list */}
          <div className="space-y-2">
            {nodes.map(node => (
              <Card
                key={node.id}
                hoverable
                onClick={() => setSelected(node.id)}
                className={`transition-all ${selected === node.id ? 'border-accent/40 bg-accent/5' : ''}`}
                padding="md"
              >
                <div className="flex items-start gap-3">
                  <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${node.status === 'ONLINE' ? 'bg-success animate-pulse-status' : 'bg-text-muted'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px] font-semibold text-text-primary truncate">{node.name}</p>
                    <p className="text-[12px] text-text-muted">{node.city ?? node.country ?? 'Local desconhecido'}</p>
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                      <span className={`badge ${node.status === 'ONLINE' ? 'badge-success' : 'badge-neutral'}`}>
                        {node.status}
                      </span>
                      <PowerRankBadge policy={node.policy} gpuCount={node.gpuCount} />
                      {(node.gpuCount ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-purple-500/10 border-purple-500/30 text-purple-300">
                          <Zap className="w-3 h-3" />{node.gpuCount} GPU
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-1 text-[12px] text-text-muted">
                      <TrendingUp className="w-3.5 h-3.5 text-success" />
                      {node._count?.assignments ?? 0} assignment{(node._count?.assignments ?? 0) !== 1 ? 's' : ''} ativo{(node._count?.assignments ?? 0) !== 1 ? 's' : ''}
                    </div>
                    {node.gpuModel && (
                      <p className="mt-1 flex items-center gap-1 text-[11px] text-purple-400">
                        <Zap className="w-3 h-3" />{node.gpuModel}
                      </p>
                    )}
                  </div>
                  <ChevronRight className={`w-4 h-4 text-text-muted mt-4 transition-transform ${selected === node.id ? 'rotate-90' : ''}`} />
                </div>
              </Card>
            ))}
          </div>

          {/* Policy editor */}
          <div className="lg:col-span-2">
            {selectedNode ? (
              <Card>
                <CardHeader
                  title={`${selectedNode.name}`}
                  description={`${selectedNode.ipAddress ?? 'IP não disponível'} · ${selectedNode.city ?? ''} ${selectedNode.country ?? ''}`}
                  icon={<Server className="w-4 h-4" />}
                />
                <CardDivider />
                <NodePolicyPanel
                  node={selectedNode}
                  surgeMultiplier={surgeMultiplier}
                  onSaved={load}
                />
              </Card>
            ) : (
              <Card className="flex items-center justify-center h-full min-h-[320px] text-center" padding="none">
                <div>
                  <Server className="w-8 h-8 text-text-muted mx-auto mb-3" />
                  <p className="text-[13px] text-text-secondary">Selecione um nó para configurar e monitorar.</p>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
