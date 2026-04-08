/**
 * useNodeTelemetry
 *
 * Subscribes to real-time telemetry for a specific node via Socket.io.
 * The hook returns the latest TelemetryPayload received from the agent,
 * updating ~every 5 seconds as the agent pushes new data.
 */
import { useState, useEffect } from 'react';
import { connectSocket, getSocket } from '../services/socket';

export interface GPUInfo {
  index: number;
  name: string;
  memory_total_mb: number;
  memory_used_mb: number;
  utilization_percent: number;
  driver_version?: string;
}

export interface DiskInfo {
  device: string;
  mountpoint: string;
  fstype: string;
  total: number;
  used: number;
  free: number;
  used_percent: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  ram: number;
  ramHeap: number;
}

export interface NodeTelemetry {
  timestamp: number;
  cpuUsage: number;
  cpuCores: number;
  ramUsage: number;
  ramTotal: number;
  ramUsed: number;
  diskUsage: number;
  diskTotal: number;
  diskUsed: number;
  disks: DiskInfo[];
  netTxSec: number;
  netRxSec: number;
  topProcs: ProcessInfo[];
  gpus: GPUInfo[];
}

export function useNodeTelemetry(nodeId: string | null): NodeTelemetry | null {
  const [telemetry, setTelemetry] = useState<NodeTelemetry | null>(null);

  useEffect(() => {
    if (!nodeId) { setTelemetry(null); return; }

    connectSocket();
    const socket = getSocket();

    const handler = (payload: { nodeId: string; data: NodeTelemetry }) => {
      if (payload.nodeId === nodeId) {
        setTelemetry(payload.data);
      }
    };

    socket.on('node:telemetry', handler);
    return () => { socket.off('node:telemetry', handler); };
  }, [nodeId]);

  return telemetry;
}
