import { useState, useEffect, useRef } from 'react';
import { Terminal, Trash2, StopCircle, PlayCircle, RefreshCw, AlertCircle } from 'lucide-react';
import { getSocket } from '../services/socket';
import api from '../services/api';

interface LogViewerProps {
  projectId: string;
}

interface LogLine {
  nodeId: string;
  containerId: string;
  line: string;
}

export default function LogViewer({ projectId }: LogViewerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = getSocket();

    const handleLog = (data: LogLine) => {
      // We could filter by containerId if we had it, but the backend currently 
      // broadcasts project logs to the room. 
      // agent-ws.service.ts broadcasts 'agent:log' to everyone right now.
      setLogs((prev) => [...prev.slice(-1000), data.line]);
    };

    socket.on('agent:log', handleLog);

    return () => {
      socket.off('agent:log', handleLog);
      if (streaming) {
        stopStreaming();
      }
    };
  }, [projectId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const startStreaming = async () => {
    setError(null);
    try {
      await api.post(`/projects/${projectId}/logs/start`);
      setStreaming(true);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha ao iniciar streaming de logs.');
    }
  };

  const stopStreaming = async () => {
    try {
      await api.post(`/projects/${projectId}/logs/stop`);
      setStreaming(false);
    } catch (err) {
      console.error('Falha ao parar logs:', err);
    }
  };

  const clearLogs = () => {
    setLogs([]);
  };

  return (
    <div className="flex flex-col h-full bg-bg-secondary rounded-xl border border-border overflow-hidden shadow-2xl animate-fade-in">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-bg-card flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-accent/10 rounded-lg text-accent">
            <Terminal className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-text-primary">Container Logs</h3>
            <p className="text-[10px] text-text-muted uppercase tracking-widest">Real-time Docker Output</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {!streaming ? (
            <button 
              onClick={startStreaming}
              className="px-3 py-1.5 rounded-lg bg-success/10 hover:bg-success/20 text-success text-xs font-bold flex items-center gap-2 transition-all"
            >
              <PlayCircle className="w-4 h-4" /> Iniciar
            </button>
          ) : (
            <button 
              onClick={stopStreaming}
              className="px-3 py-1.5 rounded-lg bg-danger/10 hover:bg-danger/20 text-danger text-xs font-bold flex items-center gap-2 transition-all"
            >
              <StopCircle className="w-4 h-4" /> Parar
            </button>
          )}
          
          <div className="h-6 w-px bg-border mx-1" />
          
          <button 
            onClick={clearLogs}
            className="p-2 rounded-lg hover:bg-bg-primary text-text-muted hover:text-text-primary transition-colors"
            title="Limpar Console"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Terminal View */}
      <div 
        ref={scrollRef}
        className="flex-1 p-4 font-mono text-xs overflow-y-auto custom-scrollbar bg-black/40"
      >
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-danger/10 border border-danger/20 text-danger flex items-center gap-3">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        
        {logs.length === 0 && !streaming && (
          <div className="h-full flex flex-col items-center justify-center text-text-muted gap-4 opacity-40">
            <Terminal className="w-12 h-12 stroke-1" />
            <p className="text-sm italic">Clique em "Iniciar" para ver os logs do container.</p>
          </div>
        )}

        {streaming && logs.length === 0 && (
          <div className="flex items-center gap-3 text-accent animate-pulse">
            <RefreshCw className="w-3 h-3 animate-spin" />
            <span>Aguardando saída do container...</span>
          </div>
        )}

        <div className="space-y-0.5">
          {logs.map((log, i) => (
            <div key={i} className="text-text-secondary leading-relaxed break-all selection:bg-accent/30">
              <span className="opacity-30 mr-3 select-none">{String(i + 1).padStart(4, '0')}</span>
              {log}
            </div>
          ))}
        </div>
      </div>

      {/* Footer Info */}
      <div className="px-4 py-2 bg-black/60 border-t border-border flex items-center justify-between text-[9px] font-bold text-text-muted uppercase tracking-widest">
        <span>Status: {streaming ? <span className="text-success">Conectado</span> : 'Offline'}</span>
        <span>{logs.length} Linhas Armazenadas</span>
      </div>
    </div>
  );
}
