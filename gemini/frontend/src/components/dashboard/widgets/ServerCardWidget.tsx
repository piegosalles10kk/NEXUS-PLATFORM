import { GaugeWidget } from './GaugeWidget';
import { StoragePieWidget } from './StoragePieWidget';
import { NetworkLineWidget } from './NetworkLineWidget';

interface ServerCardProps {
  nodeId: string;
  telemetryData: any;
  networkHistory: any[];
}

export const ServerCardWidget = ({ nodeId, telemetryData, networkHistory }: ServerCardProps) => {
  const isOnline = telemetryData && telemetryData.timestamp && (Date.now() - new Date(telemetryData.timestamp).getTime() < 60000);

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${isOnline ? 'bg-success animate-pulse' : 'bg-danger'}`} />
          <span className="text-xs text-text-muted font-bold tracking-widest uppercase">
            {isOnline ? 'Online' : 'Offline'}
          </span>
        </div>
        <div className="text-[10px] text-text-muted font-mono">
          {telemetryData?.hostname || nodeId.slice(0, 8)}
        </div>
      </div>

      <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-3 min-h-0">
        <div className="bg-bg-secondary/20 rounded-lg p-1.5 border border-border/50">
          <GaugeWidget value={telemetryData?.cpuUsage || 0} label="CPU" color="#6366f1" />
        </div>
        <div className="bg-bg-secondary/20 rounded-lg p-1.5 border border-border/50">
          <GaugeWidget value={telemetryData?.ramUsage || 0} label="RAM" color="#818cf8" />
        </div>
        <div className="bg-bg-secondary/20 rounded-lg p-1.5 border border-border/50">
          <StoragePieWidget used={telemetryData?.diskUsed || 0} total={telemetryData?.diskTotal || 1} />
        </div>
        <div className="bg-bg-secondary/20 rounded-lg p-1.5 border border-border/50 relative">
          <NetworkLineWidget data={networkHistory || []} />
        </div>
      </div>
    </div>
  );
};
