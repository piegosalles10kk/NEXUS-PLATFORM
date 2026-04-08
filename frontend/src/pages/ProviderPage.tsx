import { useState, useEffect, useCallback } from 'react';
import {
  Cpu, MemoryStick, HardDrive, Wifi, Clock,
  Server, Loader2, RefreshCw, Save, CheckCircle, AlertCircle,
  TrendingUp, Zap, Award,
} from 'lucide-react';
import api from '../services/api';
import { Card, CardHeader, CardDivider } from '../components/ui/Card';

/* ── Types ─────────────────────────────────────────────────────── */
interface NodePolicy {
  maxCpuPercent:    number;
  maxRamMb:         number;
  maxDiskGb:        number;
  maxBandwidthMbps: number;
  scheduleStart:    string;
  scheduleEnd:      string;
}

interface ProviderNode {
  id: string;
  name: string;
  status: string;
  country?: string;
  city?: string;
  ipAddress?: string;
  policy?: NodePolicy | null;
  _count?: { assignments: number };
}

/* ── Power Rank ─────────────────────────────────────────────────── */
interface RankInfo {
  rank: 'Bronze' | 'Silver' | 'Gold' | 'Platinum';
  color: string;
  bg: string;
  border: string;
  score: number;
}

function getPowerRank(p: NodePolicy): RankInfo {
  const score =
    (p.maxCpuPercent / 100) * 50 +
    (p.maxRamMb / 32768) * 30 +
    (p.maxBandwidthMbps / 10000) * 20;

  if (score >= 75) return { rank: 'Platinum', color: 'text-[#b8c7ff]', bg: 'bg-[#b8c7ff]/10', border: 'border-[#b8c7ff]/30', score };
  if (score >= 50) return { rank: 'Gold',     color: 'text-[#ffd700]', bg: 'bg-[#ffd700]/10', border: 'border-[#ffd700]/30', score };
  if (score >= 25) return { rank: 'Silver',   color: 'text-[#c8d0e0]', bg: 'bg-[#c8d0e0]/10', border: 'border-[#c8d0e0]/30', score };
  return              { rank: 'Bronze',   color: 'text-[#cd9f6a]', bg: 'bg-[#cd9f6a]/10', border: 'border-[#cd9f6a]/30', score };
}

/* ── Earnings preview ───────────────────────────────────────────── */
function calcMonthlyEarnings(p: NodePolicy, surge: number): number {
  const powerScore =
    (p.maxCpuPercent / 100) * 50 +
    (p.maxRamMb / 32768) * 30 +
    (p.maxBandwidthMbps / 10000) * 20;
  const powerFactor = 0.5 + (powerScore / 100) * 0.5; // 0.5–1.0

  const hourlyBase =
    (p.maxCpuPercent / 100) * 0.50 +
    (p.maxRamMb / 32768) * 0.30 +
    (p.maxBandwidthMbps / 10000) * 0.20;

  return hourlyBase * surge * powerFactor * 24 * 30;
}

/* ── Enhanced PolicySlider ──────────────────────────────────────── */
function PolicySlider({
  label,
  icon,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  icon: React.ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className="p-4 rounded-xl bg-white/[0.04] backdrop-blur-md border border-white/[0.06] transition-colors hover:border-white/10">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-[13px] text-text-secondary">
          <span className="text-text-muted">{icon}</span>
          {label}
        </div>
        <span
          className={`font-bold transition-all duration-150 origin-right ${
            dragging
              ? 'text-[16px] text-accent scale-110'
              : 'text-[13px] text-text-primary scale-100'
          }`}
        >
          {value}{unit}
        </span>
      </div>

      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
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
          [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-100
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

const DEFAULT_POLICY: NodePolicy = {
  maxCpuPercent:    80,
  maxRamMb:         2048,
  maxDiskGb:        20,
  maxBandwidthMbps: 100,
  scheduleStart:    '00:00',
  scheduleEnd:      '23:59',
};

/* ── NodePolicyPanel ────────────────────────────────────────────── */
function NodePolicyPanel({
  node,
  surgeMultiplier,
  onSaved,
}: {
  node: ProviderNode;
  surgeMultiplier: number;
  onSaved: () => void;
}) {
  const [policy, setPolicy] = useState<NodePolicy>(node.policy ?? DEFAULT_POLICY);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Sync when node changes
  useEffect(() => {
    setPolicy(node.policy ?? DEFAULT_POLICY);
  }, [node.id]);

  const set = (key: keyof NodePolicy) => (v: number | string) =>
    setPolicy(p => ({ ...p, [key]: v }));

  const rank = getPowerRank(policy);
  const monthly = calcMonthlyEarnings(policy, surgeMultiplier);

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
        {/* Earnings preview */}
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
        </div>

        {/* Power Rank */}
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
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-danger/10 border border-danger/20 text-danger text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

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
    </div>
  );
}

/* ── Power Rank Badge (for node card) ─────────────────────────────── */
function PowerRankBadge({ policy }: { policy?: NodePolicy | null }) {
  if (!policy) return null;
  const { rank, color, bg, border } = getPowerRank(policy);
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
        // clamp surge: 1.0 – 3.0, same as backend
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
            Configure os limites dos seus nós e veja a previsão de ganhos em tempo real.
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
                      <PowerRankBadge policy={node.policy} />
                    </div>
                    <div className="mt-2 flex items-center gap-1 text-[12px] text-text-muted">
                      <TrendingUp className="w-3.5 h-3.5 text-success" />
                      {node._count?.assignments ?? 0} assignment{(node._count?.assignments ?? 0) !== 1 ? 's' : ''} ativo{(node._count?.assignments ?? 0) !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {/* Policy editor */}
          <div className="lg:col-span-2">
            {selectedNode ? (
              <Card>
                <CardHeader
                  title={`Limites — ${selectedNode.name}`}
                  description="Os workloads DePIN atribuídos a este nó nunca ultrapassarão estes limites. As alterações são aplicadas imediatamente via push."
                  icon={<Cpu className="w-4 h-4" />}
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
                  <p className="text-[13px] text-text-secondary">Selecione um nó para configurar seus limites.</p>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
