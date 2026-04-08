import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface NetworkPoint {
  time: string;
  tx: number; // in bytes per sec
  rx: number; // in bytes per sec
}

interface NetworkLineProps {
  data: NetworkPoint[];
}

const formatSpeed = (bytes: number) => {
  if (bytes === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

export const NetworkLineWidget = ({ data }: NetworkLineProps) => {
  return (
    <div className="h-full w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <defs>
            <linearGradient id="colorTx" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#6366f1" stopOpacity={0.1}/>
              <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
            </linearGradient>
            <linearGradient id="colorRx" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#10b981" stopOpacity={0.1}/>
              <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
          <XAxis 
            dataKey="time" 
            hide 
          />
          <YAxis 
            hide 
            domain={[0, 'auto']} 
          />
          <Tooltip 
            contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px', fontSize: '10px' }}
            formatter={(value: any) => formatSpeed(value)}
          />
          <Area
            type="monotone"
            dataKey="tx"
            stroke="#6366f1"
            fillOpacity={1}
            fill="url(#colorTx)"
            strokeWidth={1.5}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="rx"
            stroke="#10b981"
            fillOpacity={1}
            fill="url(#colorRx)"
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
      
      {/* Legend */}
      <div className="absolute bottom-2 right-4 flex items-center gap-3 text-[9px] font-bold uppercase tracking-widest bg-bg-card/80 backdrop-blur-sm px-2 py-1 rounded-md border border-border">
        <div className="flex items-center gap-1">
          <div className="w-1.5 h-1.5 rounded-full bg-accent" />
          <span className="text-text-secondary">TX</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-1.5 h-1.5 rounded-full bg-success" />
          <span className="text-text-secondary">RX</span>
        </div>
      </div>
    </div>
  );
};
