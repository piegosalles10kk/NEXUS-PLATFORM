import { Zap, Globe, MapPin } from 'lucide-react';
import { useState, useEffect } from 'react';
import api from '../../services/api';

interface SurgeInfo {
  priceMultiplier: number;
  surgeExplanation?: string;
  region?: string;
}

interface Props {
  codeHint?: string;
  region?: string;
  mode?: 'global' | 'region';
  onMultiplier?: (m: number) => void;
}

export function SurgePricingBadge({ codeHint = 'generic API service', region, mode = 'global', onMultiplier }: Props) {
  const [surge, setSurge] = useState<SurgeInfo | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.post('/depin/classify', { codeHint, region: mode === 'global' ? undefined : region })
      .then(res => {
        const d = res.data.data;
        setSurge(d);
        onMultiplier?.(d.priceMultiplier);
      })
      .catch(() => setSurge(null))
      .finally(() => setLoading(false));
  }, [codeHint, region, mode]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-text-muted animate-pulse">
        <Zap className="w-3.5 h-3.5" />
        Calculando preço…
      </div>
    );
  }

  if (!surge) return null;

  const multiplier = surge.priceMultiplier;
  const isSurge = multiplier > 1.2;

  return (
    <div className={`flex items-start gap-2 px-3 py-2.5 rounded-xl border text-[12px] ${
      isSurge
        ? 'border-warning/30 bg-warning/5 text-warning'
        : 'border-success/30 bg-success/5 text-success'
    }`}>
      <Zap className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <div>
        <div className="flex items-center gap-2">
          <span className="font-semibold">
            {isSurge ? `Surge ${multiplier.toFixed(1)}x` : 'Preço normal'}
          </span>
          <span className="flex items-center gap-1 text-text-muted">
            {mode === 'global' ? <Globe className="w-3 h-3" /> : <MapPin className="w-3 h-3" />}
            {mode === 'global' ? 'Global' : (region ?? 'Região')}
          </span>
        </div>
        {surge.surgeExplanation && (
          <p className="text-text-muted mt-0.5 leading-snug">{surge.surgeExplanation}</p>
        )}
      </div>
    </div>
  );
}
