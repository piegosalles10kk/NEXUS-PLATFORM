/**
 * ConstellationDashWidget — mini versão do Constellation View para o Dashboard.
 * Mostra a rede de um app DePIN com codinomes estelares em canvas animado.
 * Carrega dados de GET /v1/scheduler/apps/:appId/telemetry/net
 */
import { useEffect, useRef, useState } from 'react';
import api from '../../../services/api';
import { Loader2, Star } from 'lucide-react';

interface NetNode { id: string; alias: string; status: string }
interface NetEdge  { from: string; to: string; type: 'net' | 'fail' | 'gpu'; latencyMs?: number | null }

export function ConstellationDashWidget({ appId, appName }: { appId: string; appName?: string }) {
  const [nodes, setNodes] = useState<NetNode[]>([]);
  const [edges, setEdges] = useState<NetEdge[]>([]);
  const [loading, setLoading] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const physRef   = useRef<(NetNode & { x: number; y: number; vx: number; vy: number })[]>([]);
  const frameRef  = useRef(0);
  const tickRef   = useRef(0);

  useEffect(() => {
    setLoading(true);
    api.get(`/v1/scheduler/apps/${appId}/telemetry/net`)
      .then(r => { setNodes(r.data.data.nodes); setEdges(r.data.data.edges); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [appId]);

  useEffect(() => {
    const W = canvasRef.current?.width ?? 200;
    const H = canvasRef.current?.height ?? 140;
    const angle = (2 * Math.PI) / Math.max(nodes.length, 1);
    physRef.current = nodes.map((n, i) => ({
      ...n,
      x: W / 2 + Math.cos(i * angle) * (W * 0.32),
      y: H / 2 + Math.sin(i * angle) * (H * 0.32),
      vx: 0, vy: 0,
    }));
  }, [nodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width; const H = canvas.height;
    const CX = W / 2; const CY = H / 2;

    const tick = () => {
      tickRef.current++;
      const ps = physRef.current;

      for (let i = 0; i < ps.length; i++) {
        ps[i].vx += (CX - ps[i].x) * 0.004;
        ps[i].vy += (CY - ps[i].y) * 0.004;
        for (let j = 0; j < ps.length; j++) {
          if (i === j) continue;
          const dx = ps[i].x - ps[j].x; const dy = ps[i].y - ps[j].y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = 600 / (d * d);
          ps[i].vx += (dx / d) * f; ps[i].vy += (dy / d) * f;
        }
        ps[i].vx *= 0.85; ps[i].vy *= 0.85;
        ps[i].x = Math.max(16, Math.min(W - 16, ps[i].x + ps[i].vx));
        ps[i].y = Math.max(16, Math.min(H - 16, ps[i].y + ps[i].vy));
      }

      ctx.fillStyle = 'rgba(2,2,10,0.88)'; ctx.fillRect(0, 0, W, H);

      const nodeMap = new Map(ps.map(p => [p.id, p]));
      for (const e of edges) {
        const a = nodeMap.get(e.from); const b = nodeMap.get(e.to);
        if (!a || !b) continue;
        const pulse = 0.35 + 0.25 * Math.sin(tickRef.current * 0.05);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = e.type === 'fail'
          ? `rgba(239,68,68,${pulse * 0.5})`
          : e.type === 'gpu'
            ? `rgba(34,197,94,${pulse * 0.7})`
            : `rgba(139,92,246,${pulse * 0.6})`;
        ctx.lineWidth = 1; ctx.stroke();

        // Show latency on edge midpoint
        if (e.latencyMs != null && e.latencyMs > 0) {
          const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
          ctx.fillStyle = 'rgba(180,180,180,0.7)';
          ctx.font = '7px monospace'; ctx.textAlign = 'center';
          ctx.fillText(`${e.latencyMs.toFixed(0)}ms`, mx, my - 2);
        }
      }

      for (const p of ps) {
        const online = p.status === 'RUNNING';
        const pulse  = 1 + 0.12 * Math.sin(tickRef.current * 0.05);
        const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 14 * pulse);
        grd.addColorStop(0, online ? 'rgba(139,92,246,0.5)' : 'rgba(239,68,68,0.4)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.beginPath(); ctx.arc(p.x, p.y, 14 * pulse, 0, Math.PI * 2);
        ctx.fillStyle = grd; ctx.fill();

        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle   = online ? '#a78bfa' : '#7f1d1d';
        ctx.strokeStyle = online ? '#c4b5fd' : '#ef4444';
        ctx.lineWidth = 1; ctx.fill(); ctx.stroke();

        ctx.fillStyle = online ? '#ddd6fe' : '#fca5a5';
        ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center';
        ctx.fillText(p.alias, p.x, p.y + 14);
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [nodes, edges]);

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
    </div>
  );

  if (nodes.length === 0) return (
    <div className="flex flex-col items-center justify-center h-full gap-2 opacity-50">
      <Star className="w-6 h-6 text-violet-400" />
      <p className="text-xs text-text-muted">Sem nós atribuídos</p>
    </div>
  );

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        width={400}
        height={280}
        className="w-full h-full rounded"
        style={{ background: '#02020a', display: 'block' }}
      />
      {appName && (
        <div className="absolute bottom-2 left-2 text-[9px] text-violet-300/60 font-mono">
          {nodes.length} estrelas · {appName}
        </div>
      )}
    </div>
  );
}
