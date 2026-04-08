import { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';

interface GaugeProps {
  value: number; // 0 to 100
  label: string;
  color?: string;
  unit?: string;
}

export const GaugeWidget = ({ value, label, color = '#6366f1', unit = '%' }: GaugeProps) => {
  const data = useMemo(() => [
    { value: value > 100 ? 100 : value },
    { value: 100 - (value > 100 ? 100 : value) },
  ], [value]);

  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="w-full h-full relative flex items-center justify-center">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="70%"
              startAngle={180}
              endAngle={0}
              innerRadius="65%"
              outerRadius="90%"
              paddingAngle={0}
              dataKey="value"
              stroke="none"
            >
              <Cell key="cell-0" fill={color} />
              <Cell key="cell-1" fill="rgba(255, 255, 255, 0.05)" />
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        
        {/* Value Overlay */}
        <div className="absolute top-[55%] left-1/2 -translate-x-1/2 flex flex-col items-center">
          <span className="text-xl font-bold text-text-primary tracking-tighter">
            {Math.round(value)}{unit}
          </span>
          <span className="text-[9px] uppercase tracking-widest text-text-muted font-semibold -mt-1">
            {label}
          </span>
        </div>
      </div>
    </div>
  );
};
