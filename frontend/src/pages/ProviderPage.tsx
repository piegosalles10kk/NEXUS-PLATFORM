import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Cpu, MemoryStick, HardDrive, Wifi, Clock,
  Server, Loader2, RefreshCw, Save, CheckCircle, AlertCircle,
  TrendingUp, Zap, Award, Network, Activity,
  ArrowUp, ArrowDown, Eye, Globe, Radio,
} from 'lucide-react';
import api from '../services/api';
import { Card, CardHeader, CardDivider } from '../components/ui/Card';
import { useNodeTelemetry } from '../hooks/useNodeTelemetry';

/* ── Types ─────────────────────────────────────────────────────── */
interface NodePolicy {
  maxCpuPercent:        number;
  maxRamMb:             number;
  maxDiskGb:            number;
  maxBandwidthMbps:     number;
  scheduleStart:        string;
  scheduleEnd:          string;
  offerGpu:             boolean;
  maxGpuPercent:        number;
  offerNetworkTransit:  boolean;
  transitBandwidthMbps: number;
}

interface ProviderNode {
  id:            string;
  name:          string;
  status:        string;
  country?:      string;
  city?:         string;
  ipAddress?:    string;
  gpuModel?:     string | null;
  gpuMemoryMb?:  number | null;
  gpuCount:      number;
  transitStatus: string;
  policy?:       NodePolicy | null;
  _count?:       { assignments: number };
}

/* ── Regional multipliers (mirror of pricing.service.ts) ────────── */
const REGIONAL: Record<string, number> = {
  US:1.00,CA:1.03,BR:0.90,AR:0.85,MX:0.88,GB:1.08,DE:1.07,FR:1.07,
  NL:1.06,IE:1.05,SE:1.06,JP:1.18,KR:1.15,SG:1.12,AU:1.14,IN:0.82,ZA:0.88,
};
const BASE = { cpuPerHour:0.048, ramGbPerHour:0.006, gpuPerHour:0.263, netGbTransit:0.045 };

function getRegional(c?: string|null) { return REGIONAL[(c??'').toUpperCase()]??1.0; }

function estimateMonthly(p: NodePolicy, country: string|undefined, surge: number): number {
  const m = getRegional(country)*surge, H=24*30, U=0.60;
  const cpu = (p.maxCpuPercent/100)*BASE.cpuPerHour*m*H*U;
  const ram = (p.maxRamMb/1024)*BASE.ramGbPerHour*m*H*U;
  const gpu = p.offerGpu?(p.maxGpuPercent/100)*BASE.gpuPerHour*m*H*U:0;
  const net = p.offerNetworkTransit?(p.transitBandwidthMbps/8/1024)*3600*H*U*BASE.netGbTransit*m:0;
  return cpu+ram+gpu+net;
}

/* ── Power Rank ─────────────────────────────────────────────────── */
interface RankInfo{rank:string;color:string;bg:string;border:string;score:number}
function getPowerRank(p:NodePolicy, hasGpu:boolean):RankInfo{
  const score=(p.maxCpuPercent/100)*40+(p.maxRamMb/32768)*25+(p.maxBandwidthMbps/10000)*15
    +(hasGpu&&p.offerGpu?(p.maxGpuPercent/100)*15:0)
    +(p.offerNetworkTransit?(p.transitBandwidthMbps/10000)*5:0);
  if(score>=70)return{rank:'Platinum',color:'text-[#b8c7ff]',bg:'bg-[#b8c7ff]/10',border:'border-[#b8c7ff]/30',score};
  if(score>=45)return{rank:'Gold',    color:'text-[#ffd700]',bg:'bg-[#ffd700]/10',border:'border-[#ffd700]/30',score};
  if(score>=22)return{rank:'Silver',  color:'text-[#c8d0e0]',bg:'bg-[#c8d0e0]/10',border:'border-[#c8d0e0]/30',score};
  return           {rank:'Bronze',  color:'text-[#cd9f6a]',bg:'bg-[#cd9f6a]/10',border:'border-[#cd9f6a]/30',score};
}

function fmt(b:number):string{
  if(b>=1e9)return(b/1e9).toFixed(1)+' GB';
  if(b>=1e6)return(b/1e6).toFixed(1)+' MB';
  if(b>=1e3)return(b/1e3).toFixed(1)+' KB';
  return b.toFixed(0)+' B';
}

/* ── Network history ring buffer ────────────────────────────────── */
const MAX_SAMPLES = 50;
function useNetworkHistory(nodeId:string|null):{tx:number;rx:number}[]{
  const t=useNodeTelemetry(nodeId);
  const buf=useRef<{tx:number;rx:number}[]>([]);
  const[,forceRender]=useState(0);
  useEffect(()=>{
    if(!t)return;
    buf.current=[...buf.current.slice(-(MAX_SAMPLES-1)),{tx:t.netTxSec,rx:t.netRxSec}];
    forceRender(n=>n+1);
  },[t]);
  return buf.current;
}

/* ── PulseChart ─────────────────────────────────────────────────── */
function PulseChart({nodeId,height=56}:{nodeId:string;height?:number}){
  const history=useNetworkHistory(nodeId);
  const W=300,H=height;

  if(history.length<2){
    return(
      <div style={{height:H}} className="flex items-center justify-center">
        <div className="flex items-center gap-2 text-[12px] text-text-muted">
          <Radio className="w-3.5 h-3.5 animate-pulse text-success"/>
          Aguardando pacotes…
        </div>
      </div>
    );
  }

  const combined=history.map(p=>p.tx+p.rx);
  const maxVal=Math.max(...combined,1024);

  const txPts=history.map((p,i)=>{
    const x=(i/(history.length-1))*W;
    const y=H-(p.tx/maxVal)*(H-6)-3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const rxPts=history.map((p,i)=>{
    const x=(i/(history.length-1))*W;
    const y=H-(p.rx/maxVal)*(H-6)-3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const txPath=`M ${txPts.join(' L ')}`;
  const rxPath=`M ${rxPts.join(' L ')}`;
  const lastTx=history[history.length-1].tx;
  const lastRx=history[history.length-1].rx;
  const lastTxY=H-(lastTx/maxVal)*(H-6)-3;
  const lastRxY=H-(lastRx/maxVal)*(H-6)-3;

  return(
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{height:H}} preserveAspectRatio="none">
        <defs>
          <linearGradient id="tx-grad" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.4"/>
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0.9"/>
          </linearGradient>
          <linearGradient id="rx-grad" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.4"/>
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0.9"/>
          </linearGradient>
          <filter id="glow-g"><feGaussianBlur stdDeviation="1.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="glow-b"><feGaussianBlur stdDeviation="1.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        {/* TX line */}
        <path d={`${txPath} L ${W},${H} L 0,${H} Z`} fill="url(#tx-grad)" fillOpacity="0.06"/>
        <path d={txPath} stroke="url(#tx-grad)" strokeWidth="1.5" fill="none" filter="url(#glow-g)"/>
        <circle cx={W} cy={lastTxY} r="3" fill="#22c55e" opacity="0.9"/>
        {/* RX line */}
        <path d={`${rxPath} L ${W},${H} L 0,${H} Z`} fill="url(#rx-grad)" fillOpacity="0.06"/>
        <path d={rxPath} stroke="url(#rx-grad)" strokeWidth="1.5" fill="none" filter="url(#glow-b)" strokeDasharray="none"/>
        <circle cx={W} cy={lastRxY} r="3" fill="#6366f1" opacity="0.9"/>
      </svg>
      {/* Legend */}
      <div className="absolute top-1 right-1 flex items-center gap-2 text-[10px] text-text-muted">
        <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-success inline-block rounded"/>TX {fmt(lastTx)}/s</span>
        <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-accent inline-block rounded"/>RX {fmt(lastRx)}/s</span>
      </div>
    </div>
  );
}

const DEFAULT_POLICY:NodePolicy={
  maxCpuPercent:80,maxRamMb:2048,maxDiskGb:20,maxBandwidthMbps:100,
  scheduleStart:'00:00',scheduleEnd:'23:59',
  offerGpu:false,maxGpuPercent:100,
  offerNetworkTransit:false,transitBandwidthMbps:100,
};

/* ── MiniBar ────────────────────────────────────────────────────── */
function MiniBar({pct,color='bg-accent'}:{pct:number;color?:string}){
  return(
    <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
      <div className={`h-full rounded-full ${color} transition-all duration-700`} style={{width:`${Math.min(pct,100)}%`}}/>
    </div>
  );
}

/* ── PolicySlider ───────────────────────────────────────────────── */
function PolicySlider({label,icon,value,min,max,step,unit,onChange}:{
  label:string;icon:React.ReactNode;value:number;min:number;max:number;step:number;unit:string;onChange:(v:number)=>void;
}){
  const[dragging,setDragging]=useState(false);
  const pct=((value-min)/(max-min))*100;
  return(
    <div className="p-4 rounded-xl bg-white/[0.04] backdrop-blur-md border border-white/[0.06] hover:border-white/10 transition-colors">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-[13px] text-text-secondary">
          <span className="text-text-muted">{icon}</span>{label}
        </div>
        <span className={`font-bold transition-all duration-150 ${dragging?'text-[17px] text-accent':'text-[13px] text-text-primary'}`}>
          {value}{unit}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onMouseDown={()=>setDragging(true)} onMouseUp={()=>setDragging(false)}
        onTouchStart={()=>setDragging(true)} onTouchEnd={()=>setDragging(false)}
        onChange={e=>onChange(Number(e.target.value))}
        style={{'--pct':`${pct}%`} as React.CSSProperties}
        className="w-full h-2 rounded-full appearance-none cursor-pointer
          [background:linear-gradient(to_right,#6366f1_var(--pct),rgba(255,255,255,0.08)_var(--pct))]
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
          [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:cursor-pointer
          [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-0"
      />
      <div className="flex justify-between text-[11px] text-text-muted mt-1.5">
        <span>{min}{unit}</span><span>{Math.round(pct)}%</span><span>{max}{unit}</span>
      </div>
    </div>
  );
}

/* ── Toggle ─────────────────────────────────────────────────────── */
function Toggle({value,onChange,label,description}:{value:boolean;onChange:(v:boolean)=>void;label:string;description?:string;}){
  return(
    <div className="flex items-start justify-between gap-4 p-4 rounded-xl bg-white/[0.04] border border-white/[0.06]">
      <div>
        <p className="text-[13px] font-semibold text-text-primary">{label}</p>
        {description&&<p className="text-[12px] text-text-muted mt-0.5">{description}</p>}
      </div>
      <button onClick={()=>onChange(!value)}
        className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${value?'bg-accent':'bg-white/[0.12]'}`}>
        <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${value?'translate-x-5':'translate-x-0'}`}/>
      </button>
    </div>
  );
}

/* ── Live Telemetry Panel ───────────────────────────────────────── */
function TelemetryPanel({nodeId}:{nodeId:string}){
  const t=useNodeTelemetry(nodeId);
  if(!t) return(
    <div className="flex items-center gap-2 text-[13px] text-text-muted py-8 justify-center">
      <Activity className="w-4 h-4 animate-pulse"/>Aguardando telemetria…
    </div>
  );
  return(
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.05]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] text-text-muted flex items-center gap-1"><Cpu className="w-3 h-3"/>CPU</span>
            <span className="text-[13px] font-bold text-text-primary">{t.cpuUsage.toFixed(1)}%</span>
          </div>
          <MiniBar pct={t.cpuUsage} color={t.cpuUsage>80?'bg-danger':t.cpuUsage>60?'bg-warning':'bg-success'}/>
          <p className="text-[11px] text-text-muted mt-1">{t.cpuCores} cores</p>
        </div>
        <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.05]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] text-text-muted flex items-center gap-1"><MemoryStick className="w-3 h-3"/>RAM</span>
            <span className="text-[13px] font-bold text-text-primary">{t.ramUsage.toFixed(1)}%</span>
          </div>
          <MiniBar pct={t.ramUsage} color={t.ramUsage>85?'bg-danger':t.ramUsage>65?'bg-warning':'bg-accent'}/>
          <p className="text-[11px] text-text-muted mt-1">{fmt(t.ramUsed)} / {fmt(t.ramTotal)}</p>
        </div>
      </div>

      <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.05]">
        <p className="text-[12px] text-text-muted mb-2 flex items-center gap-1"><Wifi className="w-3 h-3"/>Rede</p>
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-1 text-[13px]"><ArrowUp className="w-3 h-3 text-success"/>{fmt(t.netTxSec)}/s</span>
          <span className="flex items-center gap-1 text-[13px]"><ArrowDown className="w-3 h-3 text-info"/>{fmt(t.netRxSec)}/s</span>
        </div>
      </div>

      {(t.disks?.length>0?t.disks:[]).map((d,i)=>(
        <div key={i} className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.05]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] text-text-muted flex items-center gap-1"><HardDrive className="w-3 h-3"/>{d.mountpoint}</span>
            <span className="text-[13px] font-bold text-text-primary">{d.used_percent.toFixed(1)}%</span>
          </div>
          <MiniBar pct={d.used_percent} color={d.used_percent>90?'bg-danger':d.used_percent>70?'bg-warning':'bg-accent'}/>
          <p className="text-[11px] text-text-muted mt-1">{fmt(d.used)} / {fmt(d.total)}</p>
        </div>
      ))}

      {(t.gpus?.length>0?t.gpus:[]).map((g,i)=>(
        <div key={i} className="p-3 rounded-xl bg-[#6366f1]/10 border border-[#6366f1]/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] text-text-muted flex items-center gap-1"><Eye className="w-3 h-3 text-[#a5b4fc]"/>GPU {g.index} — {g.name}</span>
            <span className="text-[13px] font-bold text-[#a5b4fc]">{g.utilization_percent}%</span>
          </div>
          <MiniBar pct={g.utilization_percent} color="bg-[#6366f1]"/>
          <p className="text-[11px] text-text-muted mt-1">
            VRAM {g.memory_used_mb} / {g.memory_total_mb} MB{g.driver_version&&` · Driver ${g.driver_version}`}
          </p>
        </div>
      ))}
    </div>
  );
}

/* ── NodePolicyPanel ────────────────────────────────────────────── */
function NodePolicyPanel({node,surgeMultiplier,onSaved}:{node:ProviderNode;surgeMultiplier:number;onSaved:()=>void;}){
  const[policy,setPolicy]=useState<NodePolicy>(node.policy??DEFAULT_POLICY);
  const[saving,setSaving]=useState(false);
  const[saved,setSaved]=useState(false);
  const[error,setError]=useState('');
  const[tab,setTab]=useState<'limits'|'telemetry'>('limits');

  useEffect(()=>{setPolicy(node.policy??DEFAULT_POLICY);},[node.id]);

  const set=(key:keyof NodePolicy)=>(v:number|string|boolean)=>setPolicy(p=>({...p,[key]:v}));
  const hasGpu=node.gpuCount>0;
  const rank=getPowerRank(policy,hasGpu);
  const monthly=estimateMonthly(policy,node.country,surgeMultiplier);

  const handleSave=async()=>{
    setSaving(true);setError('');
    try{
      await api.put(`/v1/agent/nodes/${node.id}/policy`,policy);
      setSaved(true);setTimeout(()=>setSaved(false),2500);onSaved();
    }catch(err:any){setError(err.response?.data?.message??'Erro ao salvar.');}
    finally{setSaving(false);}
  };

  return(
    <div className="space-y-4">
      {/* Earnings + Rank */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-4 rounded-xl bg-success/5 border border-success/20">
          <div className="flex items-center gap-1.5 text-[12px] text-text-muted mb-1">
            <TrendingUp className="w-3.5 h-3.5 text-success"/>Previsão mensal
          </div>
          <p className="text-[22px] font-bold text-success leading-none">${monthly.toFixed(2)}</p>
          {surgeMultiplier>1.05&&(
            <p className="text-[11px] text-text-muted mt-1 flex items-center gap-1">
              <Zap className="w-3 h-3 text-yellow-400"/>surge {surgeMultiplier.toFixed(2)}×
            </p>
          )}
          <p className="text-[10px] text-text-muted mt-1.5">~60% utilização estimada · 50% abaixo da AWS</p>
        </div>
        <div className={`p-4 rounded-xl border ${rank.bg} ${rank.border}`}>
          <div className="flex items-center gap-1.5 text-[12px] text-text-muted mb-1">
            <Award className="w-3.5 h-3.5"/>Power Rank
          </div>
          <p className={`text-[22px] font-bold leading-none ${rank.color}`}>{rank.rank}</p>
          <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${rank.color.replace('text-','bg-')}`}
              style={{width:`${Math.min(rank.score,100)}%`}}/>
          </div>
          <p className="text-[10px] text-text-muted mt-1.5">{rank.score.toFixed(0)}/100 pts</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-white/[0.04] rounded-xl">
        {(['limits','telemetry'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            className={`flex-1 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${tab===t?'bg-white/[0.08] text-text-primary':'text-text-muted hover:text-text-secondary'}`}>
            {t==='limits'?'⚙ Limites':'📡 Telemetria ao vivo'}
          </button>
        ))}
      </div>

      {tab==='telemetry'?(
        <TelemetryPanel nodeId={node.id}/>
      ):(
        <div className="space-y-3">
          {error&&(
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-danger/10 border border-danger/20 text-danger text-sm">
              <AlertCircle className="w-4 h-4 shrink-0"/>{error}
            </div>
          )}

          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-widest">Computação</p>
          <PolicySlider label="CPU máxima" icon={<Cpu className="w-3.5 h-3.5"/>}
            value={policy.maxCpuPercent} min={10} max={100} step={5} unit="%"
            onChange={set('maxCpuPercent') as (v:number)=>void}/>
          <PolicySlider label="RAM máxima" icon={<MemoryStick className="w-3.5 h-3.5"/>}
            value={policy.maxRamMb} min={256} max={32768} step={256} unit=" MB"
            onChange={set('maxRamMb') as (v:number)=>void}/>
          <PolicySlider label="Disco máximo" icon={<HardDrive className="w-3.5 h-3.5"/>}
            value={policy.maxDiskGb} min={1} max={500} step={1} unit=" GB"
            onChange={set('maxDiskGb') as (v:number)=>void}/>

          {hasGpu&&(
            <>
              <CardDivider/>
              <p className="text-[11px] font-semibold text-text-muted uppercase tracking-widest">
                GPU — {node.gpuModel??'Detectada'} ({node.gpuCount}×)
                {node.gpuMemoryMb&&<span className="normal-case font-normal"> · {node.gpuMemoryMb} MB VRAM</span>}
              </p>
              <Toggle value={policy.offerGpu} onChange={set('offerGpu') as (v:boolean)=>void}
                label="Disponibilizar GPU para workloads"
                description={`Ganhe $${BASE.gpuPerHour.toFixed(3)}/h por GPU disponível (${node.gpuCount} GPU × surge × regional)`}/>
              {policy.offerGpu&&(
                <PolicySlider label="GPU máxima" icon={<Eye className="w-3.5 h-3.5"/>}
                  value={policy.maxGpuPercent} min={10} max={100} step={5} unit="%"
                  onChange={set('maxGpuPercent') as (v:number)=>void}/>
              )}
            </>
          )}

          <CardDivider/>
          {/* ── Network Transit (Apple-style) ──────────────────────── */}
          <div className="rounded-2xl border border-white/[0.08] overflow-hidden bg-white/[0.02]">
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-4 pb-3">
              <div className="flex items-center gap-2.5">
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${policy.offerNetworkTransit?'bg-success/15':'bg-white/[0.06]'}`}>
                  <Globe className={`w-4 h-4 ${policy.offerNetworkTransit?'text-success':'text-text-muted'}`}/>
                </div>
                <div>
                  <p className="text-[13px] font-semibold text-text-primary leading-tight">Nexus Flow</p>
                  <p className="text-[11px] text-text-muted leading-tight">Emprestar banda à rede</p>
                </div>
              </div>
              <button onClick={()=>(set('offerNetworkTransit') as (v:boolean)=>void)(!policy.offerNetworkTransit)}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors duration-200 ${policy.offerNetworkTransit?'bg-success':'bg-white/[0.12]'}`}>
                <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${policy.offerNetworkTransit?'translate-x-5':'translate-x-0'}`}/>
              </button>
            </div>

            {policy.offerNetworkTransit&&(
              <div className="px-4 pb-4 space-y-3 border-t border-white/[0.06] pt-3">
                {/* Pulse Activity Chart */}
                <div>
                  <p className="text-[11px] font-medium text-text-muted mb-2 flex items-center gap-1.5">
                    <Activity className="w-3 h-3 text-success"/>Atividade de rede em tempo real
                  </p>
                  <div className="rounded-xl bg-black/20 border border-white/[0.05] p-2">
                    <PulseChart nodeId={node.id}/>
                  </div>
                </div>

                {/* Bandwidth slider */}
                <PolicySlider label="Reservar para Nexus Flow" icon={<Network className="w-3.5 h-3.5"/>}
                  value={policy.transitBandwidthMbps} min={10} max={10000} step={10} unit=" Mbps"
                  onChange={set('transitBandwidthMbps') as (v:number)=>void}/>

                {/* Earnings preview per GB */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="p-3 rounded-xl bg-success/5 border border-success/20">
                    <p className="text-[10px] text-text-muted mb-1 flex items-center gap-1">
                      <TrendingUp className="w-3 h-3 text-success"/>Previsão / GB trafegado
                    </p>
                    <p className="text-[18px] font-bold text-success leading-none">
                      ${(BASE.netGbTransit*getRegional(node.country)*surgeMultiplier).toFixed(3)}
                    </p>
                    <p className="text-[10px] text-text-muted mt-1">por GB · {node.country??'Global'}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.05]">
                    <p className="text-[10px] text-text-muted mb-1 flex items-center gap-1">
                      <Wifi className="w-3 h-3"/>Pico de banda
                    </p>
                    <p className="text-[18px] font-bold text-text-primary leading-none">
                      {policy.transitBandwidthMbps<1000?`${policy.transitBandwidthMbps}M`:`${(policy.transitBandwidthMbps/1000).toFixed(1)}G`}bps
                    </p>
                    <p className="text-[10px] text-text-muted mt-1">limite reservado</p>
                  </div>
                </div>

                {/* Status when STREAMING */}
                {node.transitStatus==='STREAMING'&&(
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-success/10 border border-success/20">
                    <Radio className="w-3.5 h-3.5 text-success animate-pulse"/>
                    <span className="text-[12px] text-success font-medium">Gateway ativo — tráfego fluindo</span>
                  </div>
                )}
                {node.transitStatus==='STANDBY'&&(
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
                    <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse"/>
                    <span className="text-[12px] text-yellow-400 font-medium">Em standby — pronto para ativar</span>
                  </div>
                )}

                <p className="text-[10px] text-text-muted leading-relaxed">
                  Quando a saturação de rede superar 70%, o scheduler promove este nó a gateway automaticamente.
                  Nexus-Shield inicia um proxy isolado (64 MB RAM, 0,25 CPU) para segurança total.
                </p>
              </div>
            )}

            {!policy.offerNetworkTransit&&(
              <div className="px-4 pb-4 border-t border-white/[0.06] pt-3">
                <p className="text-[12px] text-text-muted leading-relaxed">
                  Ative para contribuir com largura de banda à rede. Quando saturação &gt;70%, este nó vira
                  gateway e você ganha <span className="text-success font-semibold">${BASE.netGbTransit.toFixed(3)}/GB</span> trafegado
                  {surgeMultiplier>1.05&&<span className="text-yellow-400"> × {surgeMultiplier.toFixed(2)} surge</span>}.
                </p>
              </div>
            )}
          </div>

          <CardDivider/>
          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-widest">Janela de disponibilidade (UTC)</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="flex items-center gap-1 text-[12px] font-medium text-text-secondary mb-1.5">
                <Clock className="w-3.5 h-3.5"/>Início
              </label>
              <input type="time" value={policy.scheduleStart}
                onChange={e=>setPolicy(p=>({...p,scheduleStart:e.target.value}))} className="input-field"/>
            </div>
            <div>
              <label className="flex items-center gap-1 text-[12px] font-medium text-text-secondary mb-1.5">
                <Clock className="w-3.5 h-3.5"/>Fim
              </label>
              <input type="time" value={policy.scheduleEnd}
                onChange={e=>setPolicy(p=>({...p,scheduleEnd:e.target.value}))} className="input-field"/>
            </div>
          </div>

          <button onClick={handleSave} disabled={saving}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-accent hover:bg-accent-light disabled:opacity-50 text-white text-sm font-semibold transition-colors">
            {saved  ?<><CheckCircle className="w-4 h-4"/>Salvo — push enviado ao agente</>
             :saving?<><Loader2 className="w-4 h-4 animate-spin"/>Salvando…</>
             :       <><Save className="w-4 h-4"/>Salvar limites</>}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Mini card badges ───────────────────────────────────────────── */
function PowerRankBadge({policy,hasGpu}:{policy?:NodePolicy|null;hasGpu:boolean}){
  if(!policy)return null;
  const{rank,color,bg,border}=getPowerRank(policy,hasGpu);
  return<span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${bg} ${border} ${color}`}><Award className="w-3 h-3"/>{rank}</span>;
}
function TransitBadge({status}:{status:string}){
  if(!status||status==='IDLE')return null;
  const map:Record<string,string>={STANDBY:'badge badge-warning',STREAMING:'badge badge-success'};
  return<span className={map[status]??'badge badge-neutral'}>{status}</span>;
}
function LiveCardBars({nodeId,status}:{nodeId:string;status:string}){
  const t=useNodeTelemetry(status==='ONLINE'?nodeId:null);
  if(!t)return null;
  return(
    <div className="mt-2 space-y-1">
      <div className="flex items-center gap-2 text-[11px] text-text-muted">
        <span className="w-6">CPU</span>
        <div className="flex-1"><MiniBar pct={t.cpuUsage} color={t.cpuUsage>80?'bg-danger':'bg-accent'}/></div>
        <span className="w-8 text-right">{t.cpuUsage.toFixed(0)}%</span>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-text-muted">
        <span className="w-6">RAM</span>
        <div className="flex-1"><MiniBar pct={t.ramUsage} color={t.ramUsage>85?'bg-danger':'bg-accent'}/></div>
        <span className="w-8 text-right">{t.ramUsage.toFixed(0)}%</span>
      </div>
      {t.gpus?.length>0&&(
        <div className="flex items-center gap-2 text-[11px] text-[#a5b4fc]">
          <span className="w-6">GPU</span>
          <div className="flex-1"><MiniBar pct={t.gpus[0].utilization_percent} color="bg-[#6366f1]"/></div>
          <span className="w-8 text-right">{t.gpus[0].utilization_percent}%</span>
        </div>
      )}
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────── */
export default function ProviderPage(){
  const[nodes,setNodes]=useState<ProviderNode[]>([]);
  const[loading,setLoading]=useState(true);
  const[selected,setSelected]=useState<string|null>(null);
  const[surge,setSurge]=useState(1.0);

  const load=useCallback(async()=>{
    setLoading(true);
    try{
      const[nr,dr]=await Promise.allSettled([api.get('/v1/agent/nodes'),api.get('/depin/demand')]);
      if(nr.status==='fulfilled') setNodes(nr.value.data.data.nodes??[]);
      if(dr.status==='fulfilled'){
        const r=dr.value.data.data.demandRatio as number;
        setSurge(Math.min(Math.max(1+(r-1)*0.5,1),3));
      }
    }catch{setNodes([]);}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{load();},[load]);

  const selectedNode=nodes.find(n=>n.id===selected)??null;

  return(
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Server className="w-5 h-5 text-accent-light"/>
            <h1 className="text-2xl font-bold text-text-primary">Provedor de Hardware</h1>
          </div>
          <p className="text-[13px] text-text-secondary">
            Dados reais dos seus nós. Configure limites, disponibilize GPU e largura de banda.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {surge>1.05&&(
            <span className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-yellow-400/10 border border-yellow-400/20 text-yellow-400 text-[12px] font-semibold">
              <Zap className="w-3.5 h-3.5"/>Surge {surge.toFixed(2)}×
            </span>
          )}
          <button onClick={load} className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-white/[0.04] transition-colors">
            <RefreshCw className="w-4 h-4"/>
          </button>
        </div>
      </div>

      {loading?(
        <div className="flex items-center justify-center h-64"><Loader2 className="w-6 h-6 text-accent animate-spin"/></div>
      ):nodes.length===0?(
        <Card className="text-center py-20" padding="none">
          <Server className="w-10 h-10 text-text-muted mx-auto mb-4"/>
          <p className="text-[14px] font-semibold text-text-primary mb-1">Nenhum nó registrado</p>
          <p className="text-[13px] text-text-secondary">Registre um nó em Cloud → Agentes para começar a ganhar.</p>
        </Card>
      ):(
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="space-y-2">
            {nodes.map(node=>(
              <Card key={node.id} hoverable onClick={()=>setSelected(node.id)}
                className={`transition-all ${selected===node.id?'border-accent/40 bg-accent/5':''}`} padding="md">
                <div className="flex items-start gap-3">
                  <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${node.status==='ONLINE'?'bg-success animate-pulse-status':'bg-text-muted'}`}/>
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px] font-semibold text-text-primary truncate">{node.name}</p>
                    <p className="text-[12px] text-text-muted">{node.city??node.country??'Local desconhecido'}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className={`badge ${node.status==='ONLINE'?'badge-success':'badge-neutral'}`}>{node.status}</span>
                      <PowerRankBadge policy={node.policy} hasGpu={node.gpuCount>0}/>
                      <TransitBadge status={node.transitStatus}/>
                    </div>
                    <LiveCardBars nodeId={node.id} status={node.status}/>
                    <div className="mt-2 flex items-center gap-3 text-[12px] text-text-muted">
                      <span className="flex items-center gap-1">
                        <TrendingUp className="w-3.5 h-3.5 text-success"/>
                        {node._count?.assignments??0} app{(node._count?.assignments??0)!==1?'s':''}
                      </span>
                      {node.gpuCount>0&&(
                        <span className="flex items-center gap-1 text-[#a5b4fc]">
                          <Eye className="w-3 h-3"/>GPU {node.gpuCount}×
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div className="lg:col-span-2">
            {selectedNode?(
              <Card>
                <CardHeader
                  title={`Limites — ${selectedNode.name}`}
                  description={`${selectedNode.ipAddress??'IP desconhecido'} · ${selectedNode.country??'Região desconhecida'}`}
                  icon={<Cpu className="w-4 h-4"/>}
                />
                <CardDivider/>
                <NodePolicyPanel node={selectedNode} surgeMultiplier={surge} onSaved={load}/>
              </Card>
            ):(
              <Card className="flex items-center justify-center h-full min-h-[320px] text-center" padding="none">
                <div>
                  <Server className="w-8 h-8 text-text-muted mx-auto mb-3"/>
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
