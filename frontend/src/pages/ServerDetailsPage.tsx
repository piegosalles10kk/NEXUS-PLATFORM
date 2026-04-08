import { useState, useEffect, useRef, FormEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
  Server, ArrowLeft, Terminal, Cpu, Activity,
  Globe, Clock, TerminalSquare, Layers, CheckCircle2, AlertCircle, Play,
  FolderTree, ShieldAlert, PowerOff
} from 'lucide-react';
import FileManager from '../components/FileManager';
import api from '../services/api';
import { getSocket } from '../services/socket';
import { XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';

export default function ServerDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'console' | 'telemetry' | 'ftp'>('overview');
  const [telemetryHistory, setTelemetryHistory] = useState<any[]>([]);

  // Terminal state
  const [command, setCommand] = useState('');
  const [logs, setLogs] = useState<{ id: number; text: string; type: 'in' | 'out' | 'err' | 'sys' }[]>([{ id: 0, text: 'Nexus Web Terminal - Connected.', type: 'sys' }]);
  const [isCommandRunning, setIsCommandRunning] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logIdCounter = useRef(1);

  useEffect(() => {
    const load = async () => {
      try {
        const [resDetails, resTelem] = await Promise.all([
          api.get(`/cloud/servers/${id}/details`),
          api.get(`/v1/agent/nodes/${id}/telemetry`).catch(() => ({ data: { data: { telemetry: [] } } }))
        ]);
        setData(resDetails.data.data);
        if (resTelem.data?.data?.telemetry) {
           setTelemetryHistory(resTelem.data.data.telemetry);
        }
      } catch (err: any) {
        alert(err.response?.data?.message || 'Falha ao carregar servidor.');
        navigate('/cloud');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id, navigate]);

  useEffect(() => {
    if (!id || !data?.node?.id) return;
    
    const socket = getSocket();
    
    // Join the server room
    socket.emit('join:server', data.node.id); // For agent to frontend socket matching, agent-ws.service emits to server:<nodeId>
    
    const onOutput = (msg: { sessionId: string; message: string }) => {
      setLogs((prev) => {
        return [...prev, { id: logIdCounter.current++, text: msg.message, type: 'out' }];
      });
    };

    const onExit = (msg: { sessionId: string; code: number }) => {
      setIsCommandRunning(false);
      if (msg.code !== 0) {
        setLogs((prev) => [...prev, { id: logIdCounter.current++, text: `[Processo encerrado com código ${msg.code}]`, type: 'err' }]);
      }
    };

    socket.on('agent:shell_output', onOutput);
    socket.on('agent:shell_exit', onExit);

    const onTelemetry = (msg: any) => {
      if (msg.nodeId === data.node.id) {
        setTelemetryHistory(prev => {
          const arr = [...prev, msg.data];
          if (arr.length > 100) arr.shift();
          return arr;
        });
      }
    };
    socket.on('node:telemetry', onTelemetry);

    return () => {
      socket.emit('leave:server', data.node.id);
      socket.off('agent:shell_output', onOutput);
      socket.off('agent:shell_exit', onExit);
      socket.off('node:telemetry', onTelemetry);
    };
  }, [id, data?.node?.id]);

  useEffect(() => {
    // Auto-scroll
    if (logsEndRef.current && activeTab === 'console') {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, activeTab]);

  const sendCommand = (e: FormEvent) => {
    e.preventDefault();
    if (!command.trim() || isCommandRunning || !data?.node?.id) return;

    setLogs((prev) => [...prev, { id: logIdCounter.current++, text: `$ ${command}`, type: 'in' }]);
    setIsCommandRunning(true);
    getSocket().emit('send_shell_command', {
      nodeId: data.node.id,
      command,
      sessionId: `web_${Date.now()}`
    });
    setCommand('');
  };

  const handleTerminateAgent = async () => {
    if (!confirm('⚠️ ATENÇÃO: Isso irá desinstalar o Nexus Agent permanentemente desta máquina. A conexão será perdida e você precisará reinstalar manualmente. Deseja continuar?')) return;
    
    try {
      await api.post(`/v1/agent/nodes/${id}/terminate`);
      alert('Comando de terminação enviado.');
      navigate('/cloud');
    } catch (err: any) {
      alert(err.response?.data?.message || 'Falha ao encerrar agente.');
    }
  };

  if (loading) {
    return <div className="flex h-64 items-center justify-center animate-pulse text-text-muted">Carregando detalhes do servidor...</div>;
  }

  if (!data || !data.server) return null;

  const { server, isManual } = data;

  return (
    <div className="space-y-6 animate-fade-in max-w-7xl mx-auto pb-10">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => navigate('/cloud')}
            className="p-2 rounded-xl border border-border bg-bg-card hover:bg-bg-card-hover text-text-secondary transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/20 flex items-center justify-center shrink-0">
              <Server className="w-6 h-6 text-accent" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
                {server.name}
                {isManual && <span className="text-[10px] px-2 py-0.5 rounded-full bg-border text-text-muted font-bold tracking-widest uppercase">Manual</span>}
              </h1>
              <p className="text-sm text-text-secondary">{server.ip || 'Sem IP'} · {server.region}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-border flex gap-6">
        <button
          onClick={() => setActiveTab('overview')}
          className={`pb-3 text-sm font-semibold border-b-2 transition-colors ${
            activeTab === 'overview' ? 'border-accent text-accent-light' : 'border-transparent text-text-muted hover:text-text-primary'
          }`}
        >
          Visão Geral & Projetos
        </button>
        <button
          onClick={() => setActiveTab('console')}
          className={`pb-3 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === 'console' ? 'border-accent text-accent-light' : 'border-transparent text-text-muted hover:text-text-primary'
          }`}
        >
          <TerminalSquare className="w-4 h-4" /> Console Remoto
        </button>
        <button
          onClick={() => setActiveTab('telemetry')}
          className={`pb-3 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === 'telemetry' ? 'border-success text-success' : 'border-transparent text-text-muted hover:text-text-primary'
          }`}
        >
          <Activity className="w-4 h-4" /> RMM / Telemetria
        </button>
        <button
          onClick={() => setActiveTab('ftp')}
          className={`pb-3 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === 'ftp' ? 'border-accent text-accent-light' : 'border-transparent text-text-muted hover:text-text-primary'
          }`}
        >
          <FolderTree className="w-4 h-4" /> Gerenciador FTP
        </button>
      </div>

      {/* Content */}
      <div className="mt-6">
        {activeTab === 'overview' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-bg-card border border-border rounded-xl p-5">
                <Glob className="w-5 h-5 text-accent-light mb-3" />
                <p className="text-xs text-text-muted uppercase font-bold tracking-wider mb-1">Status do Servidor</p>
                <div className="flex items-center gap-2">
                   {server.status === 'RUNNING' ? (
                     <span className="text-success font-bold flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> ONLINE</span>
                   ) : (
                     <span className="text-warning font-bold flex items-center gap-1.5"><AlertCircle className="w-4 h-4" /> OFFLINE</span>
                   )}
                </div>
              </div>
              <div className="bg-bg-card border border-border rounded-xl p-5">
                <Cpu className="w-5 h-5 text-accent-light mb-3" />
                <p className="text-xs text-text-muted uppercase font-bold tracking-wider mb-1">Carga / Instância</p>
                <p className="text-base font-bold text-text-primary truncate">{server.instanceType}</p>
              </div>
              <div className="bg-bg-card border border-border rounded-xl p-5">
                <Terminal className="w-5 h-5 text-accent-light mb-3" />
                <p className="text-xs text-text-muted uppercase font-bold tracking-wider mb-1">Nexus Agent</p>
                {server.agentConnected ? (
                  <p className="text-sm text-emerald-400 font-bold block bg-emerald-400/10 border border-emerald-400/20 px-2 py-0.5 rounded-md text-center">Conectado (v{server.agentVersion})</p>
                ) : (
                  <p className="text-sm text-danger font-bold block bg-danger/10 border border-danger/20 px-2 py-0.5 rounded-md text-center">Desconectado</p>
                )}
              </div>
              <div className="bg-bg-card border border-border rounded-xl p-5">
                <Layers className="w-5 h-5 text-accent-light mb-3" />
                <p className="text-xs text-text-muted uppercase font-bold tracking-wider mb-1">Projetos Atrelados</p>
                <p className="text-xl font-bold text-text-primary">{server.projects?.length || 0}</p>
              </div>
            </div>

            <div className="bg-bg-card border border-border rounded-xl overflow-hidden">
               <div className="px-6 py-4 border-b border-border bg-bg-secondary w-full">
                  <h3 className="font-bold text-text-primary">Serviços e Containers</h3>
               </div>
               <div className="p-6">
                 {(!server.projects || server.projects.length === 0) ? (
                    <p className="text-text-muted text-sm text-center">Nenhum projeto associado a este nó.</p>
                 ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {server.projects.map((p: any) => (
                         <div key={p.id} className="border border-border/50 bg-bg-primary p-4 rounded-lg flex items-center justify-between hover:border-accent/40 transition-colors cursor-pointer" onClick={() => navigate('/projects')}>
                            <div>
                               <p className="font-bold text-sm text-text-primary">{p.name}</p>
                               <p className="text-xs font-mono text-text-muted mt-1">{p.repoUrl}</p>
                            </div>
                            <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-widest ${p.status === 'ATIVO' ? 'bg-success/10 text-success border border-success/20' : 'bg-danger/10 text-danger border border-danger/20'}`}>
                               {p.status}
                            </span>
                         </div>
                      ))}
                    </div>
                 )}
               </div>
            </div>

            {/* Danger Zone */}
            <div className="bg-danger/5 border border-danger/20 rounded-xl overflow-hidden mt-6 shadow-[0_0_20px_rgba(239,68,68,0.05)]">
               <div className="px-6 py-4 border-b border-danger/10 bg-danger/10 flex items-center gap-2">
                  <ShieldAlert className="w-5 h-5 text-danger" />
                  <h3 className="font-bold text-danger">Operações Críticas (Danger Zone)</h3>
               </div>
               <div className="p-6 flex items-center justify-between">
                  <div>
                     <p className="text-sm font-bold text-text-primary">Encerrar e Desinstalar Agente</p>
                     <p className="text-xs text-text-secondary mt-1">Remove permanentemente o Nexus Agent deste servidor. Ação irreversível pelo painel.</p>
                  </div>
                  <button 
                    onClick={handleTerminateAgent}
                    className="px-6 py-2.5 rounded-xl bg-danger hover:bg-danger-hover text-white text-sm font-bold flex items-center gap-2 transition-all hover:scale-105 active:scale-95 shadow-lg shadow-danger/20"
                  >
                    <PowerOff className="w-4 h-4" /> Desinstalar Nexus Agent
                  </button>
               </div>
            </div>
          </div>
        )}

        {activeTab === 'ftp' && (
          <div className="animate-fade-in">
             <FileManager nodeId={data.node.id} />
          </div>
        )}

        {activeTab === 'console' && (
          <div className="bg-[#0c0c0c] border border-border rounded-xl overflow-hidden flex flex-col h-[600px] shadow-2xl">
            {/* Console Header */}
            <div className="px-4 py-2 border-b border-white/10 bg-[#161616] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-danger"></div>
                <div className="w-3 h-3 rounded-full bg-warning"></div>
                <div className="w-3 h-3 rounded-full bg-success"></div>
                <span className="text-xs text-white/40 ml-3 font-mono tracking-tight">{server.ip || 'Local Network'} - root / adminuser</span>
              </div>
              {!server.agentConnected && <span className="text-[10px] text-danger font-bold uppercase tracking-widest px-2 bg-danger/10 py-0.5 rounded">Agent Offline</span>}
            </div>

            {/* Logs Area */}
            <div className="flex-1 overflow-y-auto p-4 font-mono text-xs md:text-sm text-white/80 space-y-1">
              {logs.map((log) => (
                 <div key={log.id} className={`${log.type === 'in' ? 'text-accent-light' : log.type === 'err' ? 'text-danger' : log.type === 'sys' ? 'text-success/70' : 'text-zinc-300'}`}>
                    {log.type === 'out' || log.type === 'err' ? (
                      <span className="whitespace-pre-wrap">{log.text}</span>
                    ) : (
                      <span>{log.text}</span>
                    )}
                 </div>
              ))}
              <div ref={logsEndRef} />
            </div>

            {/* Input Area */}
            <form onSubmit={sendCommand} className="border-t border-white/10 bg-[#121212] flex items-center p-2">
              <span className="text-accent ml-2 mr-2 font-bold select-none">$</span>
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                disabled={!server.agentConnected || isCommandRunning}
                autoFocus
                placeholder={server.agentConnected ? (isCommandRunning ? 'Aguardando processo terminar...' : 'Digite um comando...') : 'Agente desconectado'}
                className="flex-1 bg-transparent border-none text-white font-mono text-sm focus:outline-none focus:ring-0 placeholder:text-white/20 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!server.agentConnected || isCommandRunning || !command.trim()}
                className="px-4 py-2 rounded-lg bg-accent/20 hover:bg-accent/40 text-accent-light disabled:opacity-40 transition-colors flex items-center gap-2"
              >
                {isCommandRunning ? <Clock className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              </button>
            </form>
          </div>
        )}

        {activeTab === 'telemetry' && (
          <div className="space-y-6">
            {(!telemetryHistory || telemetryHistory.length === 0) ? (
               <div className="bg-bg-card border border-border rounded-xl p-10 flex flex-col items-center justify-center">
                 <Activity className="w-10 h-10 text-text-muted mb-4 opacity-50" />
                 <p className="text-text-primary font-bold">Sem dados de telemetria</p>
                 <p className="text-text-muted text-sm mt-1">Aguardando o agente enviar as primeiras leituras ou o agente está offline.</p>
               </div>
            ) : (
               <>
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                   <div className="bg-bg-card border border-border rounded-xl p-5">
                     <p className="text-xs text-text-muted font-bold uppercase tracking-widest mb-4">Uso de CPU (%)</p>
                     <div className="h-48">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={telemetryHistory} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                            <defs>
                              <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.3}/>
                                <stop offset="95%" stopColor="#38bdf8" stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                            <XAxis dataKey="timestamp" tickFormatter={() => ''} stroke="#ffffff20" />
                            <YAxis domain={[0, 100]} stroke="#ffffff40" tick={{ fontSize: 10 }} />
                            <RechartsTooltip 
                               contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', fontSize: '12px' }}
                               labelFormatter={() => ''}
                               formatter={(v: any) => [`${Number(v).toFixed(1)}%`, 'CPU']}
                            />
                            <Area type="monotone" dataKey="cpuUsage" stroke="#38bdf8" fillOpacity={1} fill="url(#colorCpu)" isAnimationActive={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                     </div>
                   </div>

                   <div className="bg-bg-card border border-border rounded-xl p-5">
                     <p className="text-xs text-text-muted font-bold uppercase tracking-widest mb-4">Uso de Memória RAM (%)</p>
                     <div className="h-48">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={telemetryHistory} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                            <defs>
                              <linearGradient id="colorRam" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#c084fc" stopOpacity={0.3}/>
                                <stop offset="95%" stopColor="#c084fc" stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                            <XAxis dataKey="timestamp" tickFormatter={() => ''} stroke="#ffffff20" />
                            <YAxis domain={[0, 100]} stroke="#ffffff40" tick={{ fontSize: 10 }} />
                            <RechartsTooltip 
                               contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', fontSize: '12px' }}
                               labelFormatter={() => ''}
                               formatter={(v: any) => [`${Number(v).toFixed(1)}%`, 'RAM']}
                            />
                            <Area type="monotone" dataKey="ramUsage" stroke="#c084fc" fillOpacity={1} fill="url(#colorRam)" isAnimationActive={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                     </div>
                   </div>
                 </div>

                 {(() => {
                   const latest = telemetryHistory[telemetryHistory.length - 1];
                   return latest ? (
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                       <div className="bg-bg-card border border-border rounded-xl p-5 flex items-center justify-between">
                         <div>
                            <p className="text-xs text-text-muted font-bold uppercase tracking-widest mb-1">Armazenamento (Disco)</p>
                            <div className="flex items-baseline gap-2">
                               <span className="text-2xl font-bold">{latest.diskUsage ? latest.diskUsage.toFixed(1) : 0}%</span>
                               <span className="text-sm text-text-muted">
                                  {latest.diskUsed ? (latest.diskUsed / 1e9).toFixed(1) : 0}GB / {latest.diskTotal ? (latest.diskTotal / 1e9).toFixed(1) : 0}GB
                               </span>
                            </div>
                         </div>
                         <svg width="40" height="40" viewBox="0 0 40 40">
                           <circle cx="20" cy="20" r="16" fill="none" stroke="#fff" strokeOpacity="0.1" strokeWidth="6" />
                           <circle cx="20" cy="20" r="16" fill="none" stroke="#2dd4bf" strokeWidth="6" 
                                   strokeDasharray={100} strokeDashoffset={100 - (latest.diskUsage || 0)} 
                                   transform="rotate(-90 20 20)" 
                           />
                         </svg>
                       </div>
                       
                       <div className="bg-bg-card border border-border rounded-xl p-5">
                          <p className="text-xs text-text-muted font-bold uppercase tracking-widest mb-2">Tráfego de Rede</p>
                          <div className="flex gap-6">
                            <div>
                               <p className="text-[10px] text-text-muted">UPLINK (Tx)</p>
                               <p className="text-lg font-bold text-accent-light">{(latest.netTxSec / 1024).toFixed(1)} KB/s</p>
                            </div>
                            <div>
                               <p className="text-[10px] text-text-muted">DOWNLINK (Rx)</p>
                               <p className="text-lg font-bold text-success">{(latest.netRxSec / 1024).toFixed(1)} KB/s</p>
                            </div>
                          </div>
                       </div>
                     </div>
                   ) : null;
                 })()}

                 <div className="bg-bg-card border border-border rounded-xl overflow-hidden mt-4">
                    <div className="px-5 py-3 border-b border-border bg-bg-secondary">
                      <p className="text-xs font-bold uppercase tracking-widest text-text-primary">Processos em Destaque</p>
                    </div>
                    <div className="divide-y divide-border">
                       {telemetryHistory[telemetryHistory.length - 1]?.topProcs?.map((proc: any) => (
                          <div key={proc.pid} className="px-5 py-3 flex items-center justify-between hover:bg-white/5 transition-colors">
                             <div className="flex items-center gap-4">
                                <span className="text-[10px] text-text-muted font-mono w-12">{proc.pid}</span>
                                <span className="text-sm font-bold text-text-primary truncate max-w-[200px] md:max-w-xs">{proc.name}</span>
                             </div>
                             <div className="flex items-center gap-6 text-sm font-mono text-text-secondary">
                                <span className="w-16 text-right"><span className="text-[10px] text-text-muted mr-1">CPU</span>{proc.cpu.toFixed(1)}%</span>
                                <span className="w-16 text-right"><span className="text-[10px] text-text-muted mr-1">RAM</span>{proc.ram.toFixed(1)}%</span>
                             </div>
                          </div>
                       ))}
                       {(!telemetryHistory[telemetryHistory.length - 1]?.topProcs || telemetryHistory[telemetryHistory.length - 1].topProcs.length === 0) && (
                         <div className="p-4 text-center text-sm text-text-muted font-mono">Processos não reportados</div>
                       )}
                    </div>
                 </div>
               </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Glob(props: any) {
  return <Globe {...props} />;
}
