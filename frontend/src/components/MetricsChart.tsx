import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

export interface MetricPoint {
  time: string;   // HH:MM:SS label
  cpu: number;
  mem: number;
}

interface MetricsChartProps {
  data: MetricPoint[];
  cpuThreshold?: number;
  memThreshold?: number;
  containerName: string;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-bg-secondary border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
      <p className="text-text-muted mb-1">{label}</p>
      {payload.map((entry: any) => (
        <p key={entry.name} style={{ color: entry.color }} className="font-mono font-bold">
          {entry.name === 'cpu' ? 'CPU' : 'Mem'}: {entry.value.toFixed(1)}%
        </p>
      ))}
    </div>
  );
};

export default function MetricsChart({ data, cpuThreshold, memThreshold, containerName }: MetricsChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-xs text-text-muted">
        Aguardando dados de métricas...
      </div>
    );
  }

  return (
    <div>
      <p className="text-[11px] text-text-muted mb-2 font-mono">{containerName} — últimos {data.length} pontos</p>
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis
            dataKey="time"
            tick={{ fontSize: 10, fill: '#6b7280' }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 10, fill: '#6b7280' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `${v}%`}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 11 }}
            formatter={(value) => value === 'cpu' ? 'CPU %' : 'Mem %'}
          />
          {cpuThreshold !== undefined && (
            <ReferenceLine y={cpuThreshold} stroke="#ef4444" strokeDasharray="4 2" strokeOpacity={0.6} />
          )}
          {memThreshold !== undefined && (
            <ReferenceLine y={memThreshold} stroke="#8b5cf6" strokeDasharray="4 2" strokeOpacity={0.6} />
          )}
          <Line
            type="monotone"
            dataKey="cpu"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3 }}
          />
          <Line
            type="monotone"
            dataKey="mem"
            stroke="#8b5cf6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
