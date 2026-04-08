import { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

interface StoragePieProps {
  used: number; // in bytes
  total: number; // in bytes
}

const formatBytes = (bytes: number, decimals = 2) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

export const StoragePieWidget = ({ used, total }: StoragePieProps) => {
  const data = useMemo(() => [
    { name: 'Used', value: used },
    { name: 'Free', value: Math.max(0, total - used) },
  ], [used, total]);

  const COLORS = ['#ef4444', 'rgba(255, 255, 255, 0.05)'];

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius="60%"
              outerRadius="90%"
              paddingAngle={2}
              dataKey="value"
              stroke="none"
              startAngle={90}
              endAngle={450}
            >
              <Cell key="cell-0" fill={COLORS[0]} />
              <Cell key="cell-1" fill={COLORS[1]} />
            </Pie>
            <Tooltip 
              contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px', fontSize: '10px' }}
              itemStyle={{ color: '#f8fafc' }}
              formatter={(value: any) => formatBytes(value)}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      
      <div className="mt-2 flex items-center justify-between text-[10px] font-mono text-text-muted">
        <span>{formatBytes(used)}</span>
        <span className="font-bold text-text-primary">{Math.round((used/total) * 100)}%</span>
        <span>{formatBytes(total)}</span>
      </div>
    </div>
  );
};
