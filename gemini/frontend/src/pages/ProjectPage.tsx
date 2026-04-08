import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import { getSocket, joinProject, leaveProject, connectSocket } from '../services/socket';
import { useAuth } from '../contexts/AuthContext';
import {
  ArrowLeft, Activity, History, Terminal as TerminalIcon, Settings,
  Rocket, Loader2, CheckCircle2, XCircle, PauseCircle, GitCommit,
  FlaskConical, Clock, Trash2, Plus, Eye, EyeOff, Save, AlertCircle, X,
  ChevronUp, ChevronDown, Info, Layers, Cpu, HardDrive,
  Zap, RefreshCw, Square, RotateCcw, FolderOpen,
} from 'lucide-react';
import MetricsChart, { MetricPoint } from '../components/MetricsChart';
import FileManager from '../components/FileManager';
import LogViewer from '../components/LogViewer';
import AIAnalysisModal from '../components/AIAnalysisModal';

interface WorkflowStep {
  id?: string;
  order: number;
  name: string;
  type: 'LOCAL_COMMAND' | 'REMOTE_SSH_COMMAND';
  command: string;
}

interface ScalingPolicy {
  id: string;
  maxCpuPercent: number;
  maxMemPercent: number;
  maxResponseMs: number;
  minReplicas: number;
  maxReplicas: number;
  cooldownSeconds: number;
  scaleEnabled: boolean;
  lastScaleAt: string | null;
}

interface ContainerMetrics {
  instanceId: string;
  containerName: string;
  replicaIndex: number;
  cpuPercent: number;
  memPercent: number;
  responseMs: number | null;
  healthy: boolean;
  status: 'RUNNING' | 'UNHEALTHY' | 'STOPPED';
}

interface ContainerInstance {
  id: string;
  containerName: string;
  replicaIndex: number;
  status: string;
  createdAt: string;
}

interface CloudServerOption {
  id: string;
  name: string;
  ip: string | null;
  status: string;
  instanceType: string;
  region: string;
  provider: { name: string; type: string };
}

interface Project {
  id: string;
  name: string;
  repoUrl: string;
  branchTarget: string;
  environmentType: string;
  status: string;
  autoDeployEnabled: boolean;
  lbEnabled: boolean;
  lbPort: number | null;
  lbAppPort: number | null;
  lbDomain: string | null;
  lbHealthPath: string;
  proxyHost: string | null;
  proxyPort: number | null;
  cloudServerId: string | null;
  scalingPolicy: ScalingPolicy | null;
  createdAt: string;
  deploys: any[];
  steps: WorkflowStep[];
  _count: { secrets: number; deploys: number };
}

interface LogEntry {
  step: string;
  message: string;
  type: 'info' | 'error' | 'success' | 'step';
  timestamp: string;
}

interface Deploy {
  id: string;
  commitHash: string | null;
  commitMsg: string | null;
  commitAuthorName: string | null;
  commitAuthorEmail: string | null;
  status: string;
  testsPassed: number | null;
  testsTotal: number | null;
  createdAt: string;
  triggeredBy: { id: string; name: string; email: string } | null;
  logOutput: LogEntry[] | null;
}

interface Secret {
  id: string;
  keyName: string;
  projectId: string;
}

const tabs = ['Visão Geral', 'Instâncias', 'Histórico', 'Logs', 'Terminal', 'Arquivos', 'Configurações'] as const;
type Tab = typeof tabs[number];

const inputClass = 'w-full px-3 py-2.5 rounded-lg bg-bg-input border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/10 transition-colors';

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [deploys, setDeploys] = useState<Deploy[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('Visão Geral');
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [currentDeployId, setCurrentDeployId] = useState<string | null>(null);
  const [containerAction, setContainerAction] = useState<'stop' | 'restart' | null>(null);
  const [selectedDeployId, setSelectedDeployId] = useState<string | null>(null);
  const [containerMetrics, setContainerMetrics] = useState<Record<string, ContainerMetrics>>({});
  const [metricsHistory, setMetricsHistory] = useState<Record<string, MetricPoint[]>>({});
  
  // AI Analysis State
  const [analyzing, setAnalyzing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [aiResult, setAiResult] = useState<any | null>(null);
  const [showAIModal, setShowAIModal] = useState(false);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const MAX_HISTORY = 20;

  useEffect(() => {
    if (id) {
      loadProject();
      connectSocket();
      joinProject(id);

      const socket = getSocket();
      socket.on('deploy:log', (entry: LogEntry) => {
        setLogs((prev) => [...prev, entry]);
      });
      socket.on('deploy:status', (data: any) => {
        if (data.status !== 'RUNNING') {
          setDeploying(false);
          setCurrentDeployId(null);
          loadProject();
        }
      });
      socket.on('container:metrics', (metrics: ContainerMetrics) => {
        setContainerMetrics((prev) => ({ ...prev, [metrics.instanceId]: metrics }));
        const now = new Date();
        const label = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        setMetricsHistory((prev) => {
          const existing = prev[metrics.instanceId] ?? [];
          const point: MetricPoint = { time: label, cpu: metrics.cpuPercent, mem: metrics.memPercent };
          return { ...prev, [metrics.instanceId]: [...existing.slice(-MAX_HISTORY + 1), point] };
        });
      });
      socket.on('scaling:triggered', () => {
        loadProject();
      });

      return () => {
        leaveProject(id);
        socket.off('deploy:log');
        socket.off('deploy:status');
        socket.off('container:metrics');
        socket.off('scaling:triggered');
      };
    }
  }, [id]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const loadProject = async () => {
    try {
      const [projectRes, deploysRes] = await Promise.all([
        api.get(`/projects/${id}`),
        api.get(`/projects/${id}/deploys`),
      ]);
      setProject(projectRes.data.data.project);
      setDeploys(deploysRes.data.data.deploys);

      if (hasRole('ADM', 'TECNICO')) {
        const secretsRes = await api.get(`/projects/${id}/secrets`);
        setSecrets(secretsRes.data.data.secrets);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const deleteProject = async () => {
    if (!confirm(`Excluir o projeto "${project?.name}" permanentemente? Todo o histórico de deploys e segredos serão removidos.`)) return;
    try {
      await api.delete(`/projects/${id}`);
      navigate('/dashboard');
    } catch (err: any) {
      console.error('Falha ao excluir projeto:', err);
    }
  };

  const triggerDeploy = async (clean = false) => {
    setDeploying(true);
    setLogs([]);
    setActiveTab('Terminal');
    try {
      const res = await api.post(`/projects/${id}/deploys`, { clean });
      setCurrentDeployId(res.data.data.deploy.id);
    } catch (err: any) {
      setDeploying(false);
      console.error(err);
    }
  };

  const cancelDeploy = async () => {
    if (!currentDeployId) return;
    try {
      await api.post(`/deploys/${currentDeployId}/cancel`);
    } catch (err: any) {
      console.error('Falha ao cancelar deploy:', err);
    }
  };

  const stopProject = async () => {
    if (!confirm('Parar o container do projeto?')) return;
    setContainerAction('stop');
    try {
      await api.post(`/projects/${id}/stop`);
    } catch (err: any) {
      console.error('Falha ao parar container:', err);
    } finally {
      setContainerAction(null);
    }
  };

  const restartProject = async () => {
    setContainerAction('restart');
    try {
      await api.post(`/projects/${id}/restart`);
    } catch (err: any) {
      console.error('Falha ao reiniciar container:', err);
    } finally {
      setContainerAction(null);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await api.post(`/projects/${id}/sync`);
      alert('Repositório sincronizado com sucesso! Os arquivos agora estão disponíveis para análise.');
    } catch (err: any) {
      console.error('Falha ao sincronizar:', err);
      alert('Erro ao sincronizar repositório: ' + (err.response?.data?.message || err.message));
    } finally {
      setSyncing(false);
    }
  };

  const handleAIAnalysis = async () => {
    setAnalyzing(true);
    try {
      const res = await api.post(`/projects/${id}/analyze`);
      setAiResult(res.data.data);
      setShowAIModal(true);
    } catch (err: any) {
      alert(err.response?.data?.message || 'Falha ao analisar repositório.');
    } finally {
      setAnalyzing(false);
    }
  };

  if (loading || !project) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
      </div>
    );
  }

  const statusMap: Record<string, { icon: React.ReactNode; color: string; dot: string }> = {
    ATIVO: { icon: <CheckCircle2 className="w-5 h-5 text-success" />, color: 'text-success', dot: 'bg-success' },
    FALHOU: { icon: <XCircle className="w-5 h-5 text-danger" />, color: 'text-danger', dot: 'bg-danger' },
    PAUSADO: { icon: <PauseCircle className="w-5 h-5 text-warning" />, color: 'text-warning', dot: 'bg-warning' },
  };
  const currentStatus = statusMap[project.status] || statusMap.PAUSADO;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="bg-bg-card border border-border rounded-lg p-5 flex items-center gap-4">
        <button
          onClick={() => navigate('/dashboard')}
          className="p-1.5 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-card-hover transition-colors shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-text-primary truncate">{project.name}</h1>
            {currentStatus.icon}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="px-2 py-0.5 rounded-md bg-bg-secondary border border-border text-[11px] font-semibold text-text-muted uppercase tracking-wider">
              {project.environmentType}
            </span>
            <span className="text-sm text-text-muted truncate">{project.repoUrl} · {project.branchTarget}</span>
          </div>
        </div>

        {hasRole('ADM', 'TECNICO') && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleSync}
              disabled={syncing || deploying}
              title="Baixar arquivos do repositório para análise ou deploy"
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text-primary hover:bg-bg-card-hover font-semibold text-sm transition-all disabled:opacity-50"
            >
              {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4 text-accent-light" />}
              Sincronizar
            </button>
            <div className="h-6 w-px bg-border mx-1" />
            <button
              onClick={handleAIAnalysis}
              disabled={analyzing || deploying || syncing}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-accent/20 bg-accent/5 text-accent-light hover:bg-accent/10 font-semibold text-sm transition-all disabled:opacity-50"
            >
              {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4 fill-current" />}
              Analisar com IA
            </button>
            <div className="h-6 w-px bg-border mx-1" />
            {deploying && (
              <button
                onClick={cancelDeploy}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-danger/40 text-danger hover:bg-danger/8 font-semibold text-sm transition-colors"
              >
                <X className="w-4 h-4" />
                Cancelar
              </button>
            )}
            {(project.environmentType === 'NODE' || project.environmentType === 'CLOUD') && (
              <>
                <button
                  onClick={restartProject}
                  disabled={!!containerAction || deploying}
                  title="Reiniciar container"
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-bg-card-hover font-semibold text-sm disabled:opacity-50 transition-colors"
                >
                  {containerAction === 'restart' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                  Reiniciar
                </button>
                <button
                  onClick={stopProject}
                  disabled={!!containerAction || deploying}
                  title="Parar container"
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-danger/40 text-danger hover:bg-danger/8 font-semibold text-sm disabled:opacity-50 transition-colors"
                >
                  {containerAction === 'stop' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
                  Parar
                </button>
              </>
            )}
            <button
              onClick={() => triggerDeploy(true)}
              disabled={deploying}
              title="Executa um 'docker system prune' e build sem cache"
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-accent/40 text-accent-light hover:bg-accent/8 font-semibold text-sm disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${deploying ? 'animate-spin' : ''}`} />
              Deploy Limpo
            </button>
            <button
              onClick={() => triggerDeploy(false)}
              disabled={deploying}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-light text-white font-semibold text-sm disabled:opacity-50 transition-colors"
            >
              {deploying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
              {deploying ? 'Publicando...' : 'Deploy Agora'}
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        {tabs.map((tab) => {
          if (tab === 'Terminal' && !hasRole('ADM', 'TECNICO')) return null;
          if (tab === 'Configurações' && !hasRole('ADM', 'TECNICO')) return null;
          if (tab === 'Arquivos' && project.environmentType === 'LOCAL') return null;
          const icons: Record<string, any> = {
            'Visão Geral': Activity,
            'Instâncias': Layers,
            'Histórico': History,
            'Terminal': TerminalIcon,
            'Logs': TerminalIcon,
            'Arquivos': FolderOpen,
            'Configurações': Settings,
          };
          const Icon = icons[tab];
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === tab
                  ? 'border-accent text-accent-light'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              <Icon className="w-4 h-4" /> {tab}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="animate-fade-in">
        {activeTab === 'Visão Geral' && <OverviewTab project={project} deploys={deploys} />}
        {activeTab === 'Instâncias' && (
          <InstancesTab
            project={project}
            liveMetrics={containerMetrics}
            metricsHistory={metricsHistory}
            canManage={hasRole('ADM', 'TECNICO')}
          />
        )}
        {activeTab === 'Histórico' && <HistoryTab deploys={deploys} onSelect={(id) => setSelectedDeployId(id)} />}
        {activeTab === 'Logs' && <LogViewer projectId={id!} />}
        {activeTab === 'Terminal' && <LogsTab logs={logs} deploying={deploying} logsEndRef={logsEndRef} />}
        {activeTab === 'Arquivos' && (
          <FileManager
            projectId={id!}
            canEdit={hasRole('ADM', 'TECNICO')}
          />
        )}
        {activeTab === 'Configurações' && <SettingsTab project={project} secrets={secrets} onUpdate={loadProject} onDelete={deleteProject} canDelete={hasRole('ADM')} />}
      </div>

      {showAIModal && aiResult && (
        <AIAnalysisModal
          projectId={id!}
          isOpen={showAIModal}
          analysis={aiResult}
          onClose={() => setShowAIModal(false)}
          onApplied={loadProject}
        />
      )}

      {selectedDeployId && (
        <DeployLogsModal deployId={selectedDeployId} onClose={() => setSelectedDeployId(null)} />
      )}
    </div>
  );
}

function InstancesTab({
  project,
  liveMetrics,
  metricsHistory,
  canManage,
}: {
  project: Project;
  liveMetrics: Record<string, ContainerMetrics>;
  metricsHistory: Record<string, MetricPoint[]>;
  canManage: boolean;
}) {
  const [instances, setInstances] = useState<ContainerInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [scalingEvent, setScalingEvent] = useState<string | null>(null);

  const loadInstances = async () => {
    try {
      const res = await api.get(`/projects/${project.id}/instances`);
      setInstances(res.data.data.instances);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadInstances(); }, [project.id]);

  const removeInstance = async (instanceId: string) => {
    if (!confirm('Remover esta réplica? O tráfego será redistribuído para os demais containers.')) return;
    try {
      await api.delete(`/projects/${project.id}/instances/${instanceId}`);
      loadInstances();
    } catch (err: any) {
      alert(err.response?.data?.message || 'Falha ao remover instância');
    }
  };

  const scaleIn = async () => {
    try {
      await api.post(`/projects/${project.id}/scale-in`);
      setScalingEvent('Scale-in iniciado — aguardando confirmação...');
      setTimeout(() => { setScalingEvent(null); loadInstances(); }, 3000);
    } catch (err: any) {
      alert(err.response?.data?.message || 'Falha ao fazer scale-in');
    }
  };

  const activeInstances = instances.filter((i) => i.status !== 'STOPPED');

  if (!project.lbEnabled) {
    return (
      <div className="bg-bg-card border border-border rounded-lg p-10 text-center">
        <Layers className="w-10 h-10 mx-auto mb-3 text-text-muted opacity-40" />
        <p className="text-sm font-semibold text-text-secondary mb-1">Load Balancer desabilitado</p>
        <p className="text-xs text-text-muted">
          Habilite o Load Balancer nas Configurações do projeto para monitorar instâncias.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <Loader2 className="w-6 h-6 text-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {scalingEvent && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-accent/8 border border-accent/25 text-accent-light text-sm">
          <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
          <span>{scalingEvent}</span>
        </div>
      )}

      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-text-primary">
            {activeInstances.length} instância(s) ativa(s)
          </p>
          <p className="text-xs text-text-muted mt-0.5">
            Porta pública: <code className="text-accent-light">{project.lbPort}</code> · App: <code className="text-accent-light">{project.lbAppPort}</code>
            {project.lbDomain && (
              <> · Domínio: <code className="text-accent-light">{project.lbDomain}</code></>
            )}
            {project.scalingPolicy && (
              <> · Auto-scaling: <span className={project.scalingPolicy.scaleEnabled ? 'text-success' : 'text-text-muted'}>
                {project.scalingPolicy.scaleEnabled ? 'ativo' : 'inativo'}
              </span></>
            )}
          </p>
        </div>
        {canManage && activeInstances.length > 1 && (
          <button
            onClick={scaleIn}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-bg-card-hover text-sm font-semibold transition-colors"
          >
            <ChevronDown className="w-4 h-4" />
            Scale-in
          </button>
        )}
      </div>

      {/* Instance cards */}
      {activeInstances.length === 0 ? (
        <div className="bg-bg-card border border-border rounded-lg p-10 text-center">
          <p className="text-sm text-text-muted">Nenhuma instância ativa. Faça um deploy para iniciar.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {activeInstances.map((inst) => {
            const live = Object.values(liveMetrics).find((m) => m.instanceId === inst.id);
            const isHealthy = live ? live.healthy : inst.status === 'RUNNING';
            const statusColor = live?.status === 'RUNNING'
              ? 'text-success' : live?.status === 'UNHEALTHY'
              ? 'text-warning' : 'text-danger';
            const dotColor = live?.status === 'RUNNING'
              ? 'bg-success animate-pulse-status' : live?.status === 'UNHEALTHY'
              ? 'bg-warning' : 'bg-danger';

            return (
              <div key={inst.id} className="bg-bg-card border border-border rounded-lg p-5 space-y-4">
                {/* Instance header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
                      <code className="text-sm font-mono font-bold text-text-primary truncate">
                        {inst.containerName}
                      </code>
                    </div>
                    <p className={`text-xs font-semibold mt-1 ${statusColor}`}>
                      {inst.replicaIndex === 0 ? 'PRIMARY' : `RÉPLICA ${inst.replicaIndex}`}
                      {' · '}{live?.status || inst.status}
                    </p>
                  </div>
                  {canManage && inst.replicaIndex > 0 && (
                    <button
                      onClick={() => removeInstance(inst.id)}
                      className="p-1.5 rounded-md border border-danger/20 text-danger/60 hover:text-danger hover:bg-danger/8 shrink-0 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Metrics */}
                <div className="space-y-2.5">
                  {/* CPU */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5 text-xs text-text-muted">
                        <Cpu className="w-3.5 h-3.5" /> CPU
                      </div>
                      <span className="text-xs font-mono font-bold text-text-primary">
                        {live ? `${live.cpuPercent.toFixed(1)}%` : '—'}
                      </span>
                    </div>
                    <div className="h-1.5 bg-bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.min(live?.cpuPercent ?? 0, 100)}%`,
                          backgroundColor: (live?.cpuPercent ?? 0) > (project.scalingPolicy?.maxCpuPercent ?? 80) ? '#ef4444' : '#3b82f6',
                        }}
                      />
                    </div>
                  </div>

                  {/* Memory */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5 text-xs text-text-muted">
                        <HardDrive className="w-3.5 h-3.5" /> Memória
                      </div>
                      <span className="text-xs font-mono font-bold text-text-primary">
                        {live ? `${live.memPercent.toFixed(1)}%` : '—'}
                      </span>
                    </div>
                    <div className="h-1.5 bg-bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.min(live?.memPercent ?? 0, 100)}%`,
                          backgroundColor: (live?.memPercent ?? 0) > (project.scalingPolicy?.maxMemPercent ?? 80) ? '#ef4444' : '#8b5cf6',
                        }}
                      />
                    </div>
                  </div>

                  {/* Response time */}
                  <div className="flex items-center justify-between pt-1 border-t border-border">
                    <div className="flex items-center gap-1.5 text-xs text-text-muted">
                      <Zap className="w-3.5 h-3.5" /> Health check
                    </div>
                    <span className={`text-xs font-mono font-bold ${
                      live?.responseMs === null
                        ? 'text-text-muted'
                        : (live?.responseMs ?? 0) > (project.scalingPolicy?.maxResponseMs ?? 2000)
                        ? 'text-danger'
                        : 'text-success'
                    }`}>
                      {live?.responseMs !== null && live?.responseMs !== undefined
                        ? `${live.responseMs}ms`
                        : live
                        ? (isHealthy ? 'ok' : 'timeout')
                        : '—'}
                    </span>
                  </div>
                </div>

                {/* Metrics history chart */}
                {metricsHistory[inst.id] && metricsHistory[inst.id].length > 1 && (
                  <div className="pt-4 border-t border-border">
                    <MetricsChart
                      containerName={inst.containerName}
                      data={metricsHistory[inst.id]}
                      cpuThreshold={project.scalingPolicy?.maxCpuPercent}
                      memThreshold={project.scalingPolicy?.maxMemPercent}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Stopped instances (collapsed) */}
      {instances.filter((i) => i.status === 'STOPPED').length > 0 && (
        <p className="text-xs text-text-muted text-center pt-2">
          + {instances.filter((i) => i.status === 'STOPPED').length} instância(s) parada(s) não exibida(s)
        </p>
      )}
    </div>
  );
}

function OverviewTab({ project, deploys }: { project: Project; deploys: Deploy[] }) {
  const lastDeploy = deploys[0];
  const successCount = deploys.filter((d) => d.status === 'SUCCESS').length;
  const failCount = deploys.filter((d) => d.status === 'FAILED' || d.status === 'ROLLED_BACK').length;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="bg-bg-card border border-border rounded-lg p-5">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4">Status Operacional</p>
        <div className="flex items-center gap-3 mb-4">
          <div className={`w-2.5 h-2.5 rounded-full ${
            project.status === 'ATIVO' ? 'bg-success animate-pulse-status' :
            project.status === 'FALHOU' ? 'bg-danger' : 'bg-warning'
          }`} />
          <span className="text-2xl font-bold text-text-primary">{project.status}</span>
        </div>
        <div className="space-y-2 pt-4 border-t border-border">
          <p className="text-sm text-text-secondary">
            Ambiente: <span className="text-text-primary font-semibold ml-1">{project.environmentType}</span>
          </p>
          <p className="text-sm text-text-secondary">
            Branch: <span className="text-text-primary font-semibold ml-1">{project.branchTarget}</span>
          </p>
        </div>
      </div>

      <div className="bg-bg-card border border-border rounded-lg p-5">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4">Última Atualização</p>
        {lastDeploy ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <GitCommit className="w-4 h-4 text-accent-light shrink-0" />
              <code className="text-accent-light text-sm font-mono bg-accent/8 px-2 py-0.5 rounded">
                {lastDeploy.commitHash || '—'}
              </code>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed">
              {lastDeploy.commitMsg || 'Mensagem não informada'}
            </p>
            <div className="flex items-center gap-2 text-xs text-text-muted mt-4 pt-3 border-t border-border">
              <Clock className="w-3.5 h-3.5" />
              {new Date(lastDeploy.createdAt).toLocaleString('pt-BR')}
            </div>
          </>
        ) : (
          <p className="text-sm text-text-muted italic">Nenhum deploy realizado ainda.</p>
        )}
      </div>

      <div className="bg-bg-card border border-border rounded-lg p-5">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4">Métricas de Sucesso</p>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="p-3 rounded-lg bg-success/8 border border-success/20 text-center">
            <p className="text-3xl font-bold text-success">{successCount}</p>
            <p className="text-[11px] text-text-muted uppercase tracking-wider mt-1">Corretos</p>
          </div>
          <div className="p-3 rounded-lg bg-danger/8 border border-danger/20 text-center">
            <p className="text-3xl font-bold text-danger">{failCount}</p>
            <p className="text-[11px] text-text-muted uppercase tracking-wider mt-1">Falhas</p>
          </div>
        </div>
        {lastDeploy?.testsTotal && lastDeploy.testsTotal > 0 && (
          <div className="flex items-center justify-between text-sm bg-bg-primary p-3 rounded-lg border border-border">
            <div className="flex items-center gap-2 text-text-muted">
              <FlaskConical className="w-4 h-4" />
              <span className="text-xs uppercase tracking-wider">Testes</span>
            </div>
            <code className="text-sm font-mono text-success">{lastDeploy.testsPassed}/{lastDeploy.testsTotal}</code>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryTab({ deploys, onSelect }: { deploys: Deploy[]; onSelect: (id: string) => void }) {
  const statusConfig: Record<string, { icon: typeof CheckCircle2; color: string; bg: string; label?: string }> = {
    SUCCESS:     { icon: CheckCircle2, color: 'text-success',      bg: 'bg-success/8 border-success/20' },
    FAILED:      { icon: XCircle,      color: 'text-danger',       bg: 'bg-danger/8 border-danger/20' },
    RUNNING:     { icon: Loader2,      color: 'text-accent-light', bg: 'bg-accent/8 border-accent/20' },
    CANCELLED:   { icon: X,            color: 'text-warning',      bg: 'bg-warning/8 border-warning/20' },
    ROLLED_BACK: { icon: XCircle,      color: 'text-warning',      bg: 'bg-warning/8 border-warning/20', label: '↩ ROLLED BACK' },
  };

  return (
    <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-border bg-bg-secondary">
            <th className="py-3 px-5 text-[11px] font-semibold text-text-muted uppercase tracking-wider">Resultado</th>
            <th className="py-3 px-5 text-[11px] font-semibold text-text-muted uppercase tracking-wider">Git Hash</th>
            <th className="py-3 px-5 text-[11px] font-semibold text-text-muted uppercase tracking-wider">Mensagem</th>
            <th className="py-3 px-5 text-[11px] font-semibold text-text-muted uppercase tracking-wider">Testes</th>
            <th className="py-3 px-5 text-[11px] font-semibold text-text-muted uppercase tracking-wider">Autor</th>
            <th className="py-3 px-5 text-[11px] font-semibold text-text-muted uppercase tracking-wider">Data</th>
          </tr>
        </thead>
        <tbody>
          {deploys.map((deploy) => {
            const sc = statusConfig[deploy.status] || statusConfig.FAILED;
            const Icon = sc.icon;
            return (
              <tr
                key={deploy.id}
                onClick={() => onSelect(deploy.id)}
                className="border-b border-border last:border-0 hover:bg-bg-card-hover transition-colors cursor-pointer group"
              >
                <td className="py-3.5 px-5">
                  <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-semibold ${sc.color} ${sc.bg}`}>
                    <Icon className={`w-3.5 h-3.5 ${deploy.status === 'RUNNING' ? 'animate-spin' : ''}`} />
                    {sc.label ?? deploy.status}
                  </div>
                </td>
                <td className="py-3.5 px-5">
                  <code className="text-sm font-mono text-accent-light bg-accent/8 px-2 py-0.5 rounded">
                    {deploy.commitHash?.slice(0, 7) || '—'}
                  </code>
                </td>
                <td className="py-3.5 px-5">
                  <span className="text-sm text-text-secondary truncate block max-w-xs">{deploy.commitMsg || '—'}</span>
                </td>
                <td className="py-3.5 px-5">
                  <span className="text-sm font-mono text-text-secondary">
                    {deploy.testsPassed !== null ? `${deploy.testsPassed}/${deploy.testsTotal}` : '—'}
                  </span>
                </td>
                <td className="py-3.5 px-5">
                  {deploy.commitAuthorName ? (
                    <div>
                      <p className="text-sm font-semibold text-text-primary">{deploy.commitAuthorName}</p>
                      <p className="text-xs text-text-muted">{deploy.commitAuthorEmail}</p>
                    </div>
                  ) : deploy.triggeredBy ? (
                    <div>
                      <p className="text-sm font-semibold text-text-primary">{deploy.triggeredBy.name}</p>
                      <p className="text-xs text-text-muted">{deploy.triggeredBy.email}</p>
                    </div>
                  ) : (
                    <span className="text-sm text-text-muted">—</span>
                  )}
                </td>
                <td className="py-3.5 px-5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-text-muted">{new Date(deploy.createdAt).toLocaleString('pt-BR')}</span>
                    <TerminalIcon className="w-3.5 h-3.5 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  </div>
                </td>
              </tr>
            );
          })}
          {deploys.length === 0 && (
            <tr>
              <td colSpan={6} className="py-16 text-center">
                <p className="text-sm font-semibold text-text-secondary mb-1">Sem histórico de deploy</p>
                <p className="text-xs text-text-muted">Este projeto ainda não recebeu nenhuma instrução de compilação.</p>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function LogsTab({ logs, deploying, logsEndRef }: {
  logs: LogEntry[];
  deploying: boolean;
  logsEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="terminal rounded-lg p-5 h-[600px] overflow-y-auto relative">
      <div className="flex items-center gap-2.5 mb-4 pb-3 border-b border-border sticky top-0 bg-[#08080a] z-10">
        <div className={`w-2 h-2 rounded-full ${deploying ? 'bg-success animate-pulse-status' : 'bg-text-muted'}`} />
        <span className="text-xs font-semibold tracking-widest uppercase text-text-secondary font-mono">
          {deploying ? 'Recebendo pacotes...' : 'Sessão finalizada'}
        </span>
      </div>

      {logs.length === 0 ? (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <TerminalIcon className="w-12 h-12 mx-auto mb-4 opacity-15" />
            <p className="text-sm text-text-muted">Inicie um deploy para ver os logs em tempo real.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-0.5 font-mono text-[13px]">
          {logs.map((log, i) => {
            if (log.type === 'step') {
              return (
                <div key={i} className="flex items-center gap-3 my-2 py-1.5 px-2 rounded bg-accent/8 border-l-2 border-accent">
                  <span className="text-accent-light font-bold text-[12px] tracking-wide">{log.message}</span>
                </div>
              );
            }
            return (
              <div key={i} className="flex gap-4 leading-relaxed hover:bg-white/[0.02] px-1 py-0.5 rounded transition-colors">
                <span className="log-timestamp shrink-0 select-none">
                  [{new Date(log.timestamp).toLocaleTimeString('pt-BR')}]
                </span>
                <span className={`log-${log.type} break-all`}>{log.message}</span>
              </div>
            );
          })}
          <div ref={logsEndRef as any} className="h-2" />
        </div>
      )}
    </div>
  );
}

function SettingsTab({ project, secrets, onUpdate, onDelete, canDelete }: { project: Project; secrets: Secret[]; onUpdate: () => void; onDelete: () => void; canDelete: boolean }) {
  const [repoUrl, setRepoUrl] = useState(project.repoUrl);
  const [branch, setBranch] = useState(project.branchTarget);
  const [autoDeployEnabled, setAutoDeployEnabled] = useState(project.autoDeployEnabled);
  const [saving, setSaving] = useState(false);

  // LB state
  const [lbEnabled, setLbEnabled] = useState(project.lbEnabled);
  const [lbPort, setLbPort] = useState(String(project.lbPort ?? ''));
  const [lbAppPort, setLbAppPort] = useState(String(project.lbAppPort ?? ''));
  const [lbDomain, setLbDomain] = useState(project.lbDomain ?? '');
  const [lbHealthPath, setLbHealthPath] = useState(project.lbHealthPath || '/health');

  // Gateway labels state
  const [proxyHost, setProxyHost] = useState(project.proxyHost ?? '');
  const [proxyPort, setProxyPort] = useState(String(project.proxyPort ?? ''));

  // Cloud server binding
  const [cloudServerId, setCloudServerId] = useState<string>(project.cloudServerId ?? '');
  const [cloudServers, setCloudServers] = useState<CloudServerOption[]>([]);
  useEffect(() => {
    if (project.environmentType !== 'CLOUD') return;
    api.get('/cloud/servers').then((r) => setCloudServers(r.data.data.servers)).catch(() => {});
  }, [project.environmentType]);

  // Scaling policy state
  const sp = project.scalingPolicy;
  const [scaleEnabled, setScaleEnabled] = useState(sp?.scaleEnabled ?? true);
  const [maxCpu, setMaxCpu] = useState(String(sp?.maxCpuPercent ?? 80));
  const [maxMem, setMaxMem] = useState(String(sp?.maxMemPercent ?? 80));
  const [maxRespMs, setMaxRespMs] = useState(String(sp?.maxResponseMs ?? 2000));
  const [minReplicas, setMinReplicas] = useState(String(sp?.minReplicas ?? 1));
  const [maxReplicas, setMaxReplicas] = useState(String(sp?.maxReplicas ?? 3));
  const [cooldown, setCooldown] = useState(String(sp?.cooldownSeconds ?? 120));
  const [savingPolicy, setSavingPolicy] = useState(false);

  // Workflow steps local state (normalized from project.steps)
  const [steps, setSteps] = useState<WorkflowStep[]>(
    (project.steps ?? []).map((s, i) => ({ ...s, order: i + 1 }))
  );
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [workflowError, setWorkflowError] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const addStep = () => {
    setSteps((prev) => [
      ...prev,
      { order: prev.length + 1, name: '', type: 'LOCAL_COMMAND', command: '' },
    ]);
  };

  const removeStep = (idx: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, order: i + 1 })));
  };

  const moveStep = (idx: number, dir: -1 | 1) => {
    const next = [...steps];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setSteps(next.map((s, i) => ({ ...s, order: i + 1 })));
  };

  const updateStep = (idx: number, patch: Partial<WorkflowStep>) => {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const saveWorkflow = async () => {
    setSavingWorkflow(true);
    setWorkflowError('');
    try {
      await api.put(`/projects/${project.id}/workflow`, { steps });
      onUpdate();
    } catch (err: any) {
      setWorkflowError(err.response?.data?.message || 'Falha ao salvar workflow');
    } finally {
      setSavingWorkflow(false);
    }
  };

  const saveProject = async () => {
    setSaving(true);
    try {
      await api.put(`/projects/${project.id}`, {
        repoUrl,
        branchTarget: branch,
        autoDeployEnabled,
        lbEnabled,
        lbPort: lbPort ? parseInt(lbPort, 10) : null,
        lbAppPort: lbAppPort ? parseInt(lbAppPort, 10) : null,
        lbDomain: lbDomain || null,
        lbHealthPath: lbHealthPath || '/health',
        proxyHost: proxyHost || null,
        proxyPort: proxyPort ? parseInt(proxyPort, 10) : null,
        cloudServerId: cloudServerId || null,
      });
      onUpdate();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const saveScalingPolicy = async () => {
    setSavingPolicy(true);
    try {
      await api.put(`/projects/${project.id}/scaling`, {
        scaleEnabled,
        maxCpuPercent: parseFloat(maxCpu),
        maxMemPercent: parseFloat(maxMem),
        maxResponseMs: parseInt(maxRespMs, 10),
        minReplicas: parseInt(minReplicas, 10),
        maxReplicas: parseInt(maxReplicas, 10),
        cooldownSeconds: parseInt(cooldown, 10),
      });
      onUpdate();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha ao salvar política de scaling');
    } finally {
      setSavingPolicy(false);
    }
  };

  const addSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post(`/projects/${project.id}/secrets`, { keyName: newKey, value: newValue });
      setNewKey('');
      setNewValue('');
      onUpdate();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha ao adicionar secret');
    }
  };

  const revealSecret = async (secretId: string) => {
    if (revealedSecrets[secretId]) {
      setRevealedSecrets((prev) => { const n = { ...prev }; delete n[secretId]; return n; });
      return;
    }
    try {
      const res = await api.get(`/secrets/${secretId}/reveal`);
      setRevealedSecrets((prev) => ({ ...prev, [secretId]: res.data.data.secret.value }));
    } catch (err) {
      console.error(err);
    }
  };

  const deleteSecret = async (secretId: string) => {
    if (!confirm('Remover secret permanentemente? Isso pode quebrar pipelines futuros.')) return;
    try {
      await api.delete(`/secrets/${secretId}`);
      onUpdate();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-danger/8 border border-danger/25 text-danger text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="p-1 hover:bg-danger/15 rounded transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Repository Settings */}
      <div className="bg-bg-card border border-border rounded-lg p-5">
        <div className="mb-5">
          <h3 className="text-base font-bold text-text-primary">Repositório</h3>
          <p className="text-sm text-text-secondary mt-0.5">Definições base do Git para o clone da branch</p>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-5">
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">URL do Repositório</label>
            <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Branch Alvo</label>
            <input value={branch} onChange={(e) => setBranch(e.target.value)} className={inputClass} />
          </div>
        </div>
        <div className="flex items-center justify-between p-4 rounded-lg bg-bg-primary border border-border mb-5">
          <div>
            <p className="text-sm font-semibold text-text-primary">Deploy automático via webhook</p>
            <p className="text-xs text-text-muted mt-0.5">Quando ativado, pushes no GitHub disparam o pipeline automaticamente</p>
          </div>
          <button
            type="button"
            onClick={() => setAutoDeployEnabled((v) => !v)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${autoDeployEnabled ? 'bg-accent' : 'bg-border'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${autoDeployEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
        {/* Cloud Server selector — only when environmentType is CLOUD */}
        {project.environmentType === 'CLOUD' && (
          <div className="mt-5 pt-5 border-t border-border">
            <p className="text-sm font-bold text-text-primary mb-1">Servidor Cloud</p>
            <p className="text-xs text-text-muted mb-3">
              Selecione o servidor remoto onde o pipeline irá fazer o deploy. Apenas servidores com status <span className="text-success font-semibold">RUNNING</span> são exibidos.
            </p>
            {cloudServers.length === 0 ? (
              <p className="text-xs text-text-muted italic">Nenhum servidor disponível. Provisione um na aba Cloud.</p>
            ) : (
              <select
                value={cloudServerId}
                onChange={(e) => setCloudServerId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-bg-input border border-border text-text-primary text-sm focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/10 transition-colors"
              >
                <option value="">— Nenhum (deploy local) —</option>
                {cloudServers
                  .filter((s) => s.status === 'RUNNING')
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.provider.name} · {s.name} · {s.instanceType} · {s.region}{s.ip ? ` · ${s.ip}` : ''}
                    </option>
                  ))}
              </select>
            )}
          </div>
        )}

        <button
          onClick={saveProject}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary text-sm font-semibold hover:bg-bg-card-hover disabled:opacity-50 transition-colors mt-5"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Salvar Alterações
        </button>
      </div>

      {/* Load Balancer & Auto-Scaling */}
      <div className="bg-bg-card border border-border rounded-lg p-5">
        <div className="mb-5">
          <h3 className="text-base font-bold text-text-primary flex items-center gap-2">
            <Layers className="w-4 h-4 text-accent-light" />
            Load Balancer & Auto-Scaling
          </h3>
          <p className="text-sm text-text-secondary mt-0.5">
            Monitore recursos e escale automaticamente quando os limites forem atingidos
          </p>
        </div>

        {/* LB toggle */}
        <div className="flex items-center justify-between p-4 rounded-lg bg-bg-primary border border-border mb-4">
          <div>
            <p className="text-sm font-semibold text-text-primary">Habilitar Load Balancer (Traefik)</p>
            <p className="text-xs text-text-muted mt-0.5">
              Ativa roteamento via Traefik e monitoramento de instâncias
            </p>
          </div>
          <button
            type="button"
            onClick={() => setLbEnabled((v) => !v)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${lbEnabled ? 'bg-accent' : 'bg-border'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${lbEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        {lbEnabled && (
          <div className="grid grid-cols-2 gap-4 mb-5">
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                Porta Pública (nginx) <span className="text-danger">*</span>
              </label>
              <input
                type="number"
                value={lbPort}
                onChange={(e) => setLbPort(e.target.value)}
                placeholder="8080"
                className={inputClass}
              />
              <p className="text-[11px] text-text-muted mt-1">Porta exposta no host pelo load balancer</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                Porta do App (interna) <span className="text-danger">*</span>
              </label>
              <input
                type="number"
                value={lbAppPort}
                onChange={(e) => setLbAppPort(e.target.value)}
                placeholder="3000"
                className={inputClass}
              />
              <p className="text-[11px] text-text-muted mt-1">Porta que a aplicação escuta dentro do container</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                Domínio (opcional)
              </label>
              <input
                value={lbDomain}
                onChange={(e) => setLbDomain(e.target.value)}
                placeholder="app.meudominio.com"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                Path do Health Check
              </label>
              <input
                value={lbHealthPath}
                onChange={(e) => setLbHealthPath(e.target.value)}
                placeholder="/health"
                className={inputClass}
              />
            </div>
          </div>
        )}

        {/* Gateway Labels */}
        <div className="mt-5 pt-5 border-t border-border">
          <p className="text-sm font-bold text-text-primary mb-1">Gateway Dinâmico (Labels)</p>
          <p className="text-xs text-text-muted mb-4">
            O container será iniciado com as labels <code className="text-accent-light">10kk.proxy.host</code> e{' '}
            <code className="text-accent-light">10kk.proxy.port</code>. O Docker Watcher criará a rota automaticamente.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                Proxy Host (path)
              </label>
              <input
                value={proxyHost}
                onChange={(e) => setProxyHost(e.target.value)}
                placeholder="meu-api (→ /meu-api)"
                className={inputClass}
              />
              <p className="text-[11px] text-text-muted mt-1">Acessível em <code>/{'<valor>'}</code> pelo gateway</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                Porta interna do app
              </label>
              <input
                type="number"
                value={proxyPort}
                onChange={(e) => setProxyPort(e.target.value)}
                placeholder="3000"
                className={inputClass}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end mt-4">
          <button
            onClick={saveProject}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary text-sm font-semibold hover:bg-bg-card-hover disabled:opacity-50 transition-colors"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Salvar Configurações de LB
          </button>
        </div>

        {/* Scaling Policy — only when LB enabled */}
        {lbEnabled && (
          <div className="mt-6 pt-6 border-t border-border">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-bold text-text-primary">Política de Auto-Scaling</p>
                <p className="text-xs text-text-muted mt-0.5">Define os limites que disparam novas réplicas automaticamente</p>
              </div>
              <button
                type="button"
                onClick={() => setScaleEnabled((v) => !v)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${scaleEnabled ? 'bg-accent' : 'bg-border'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${scaleEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                  CPU Máx (%)
                </label>
                <input
                  type="number" min="1" max="100"
                  value={maxCpu}
                  onChange={(e) => setMaxCpu(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                  Memória Máx (%)
                </label>
                <input
                  type="number" min="1" max="100"
                  value={maxMem}
                  onChange={(e) => setMaxMem(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                  Latência Máx (ms)
                </label>
                <input
                  type="number" min="100"
                  value={maxRespMs}
                  onChange={(e) => setMaxRespMs(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                  Réplicas Mín
                </label>
                <input
                  type="number" min="1"
                  value={minReplicas}
                  onChange={(e) => setMinReplicas(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                  Réplicas Máx
                </label>
                <input
                  type="number" min="1" max="10"
                  value={maxReplicas}
                  onChange={(e) => setMaxReplicas(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                  Cooldown (seg)
                </label>
                <input
                  type="number" min="10"
                  value={cooldown}
                  onChange={(e) => setCooldown(e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-xs text-text-muted">
                Polling a cada 15s · Escala se qualquer threshold for excedido
              </p>
              <button
                onClick={saveScalingPolicy}
                disabled={savingPolicy}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-light text-white text-sm font-semibold disabled:opacity-50 transition-colors"
              >
                {savingPolicy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Salvar Política
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Workflow Builder */}
      <div className="bg-bg-card border border-border rounded-lg p-5">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-base font-bold text-text-primary">Workflow Builder</h3>
            <p className="text-sm text-text-secondary mt-0.5">Defina os passos sequenciais do pipeline</p>
          </div>
          <button
            onClick={addStep}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-bg-secondary border border-border text-text-primary text-sm font-semibold hover:bg-bg-card-hover transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Adicionar Passo
          </button>
        </div>

        {workflowError && (
          <div className="mb-4 flex items-center gap-2 p-3 rounded-lg bg-danger/8 border border-danger/25 text-danger text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">{workflowError}</span>
            <button onClick={() => setWorkflowError('')} className="p-1 hover:bg-danger/15 rounded">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {steps.length === 0 ? (
          <div className="py-10 flex flex-col items-center text-center border border-dashed border-border rounded-lg">
            <TerminalIcon className="w-8 h-8 text-text-muted mb-3" />
            <p className="text-sm font-semibold text-text-secondary">Nenhum passo configurado</p>
            <p className="text-xs text-text-muted mt-1">Clique em "Adicionar Passo" para começar</p>
          </div>
        ) : (
          <div className="space-y-3 mb-5">
            {steps.map((step, idx) => (
              <div key={idx} className="border border-border rounded-lg p-4 bg-bg-primary">
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-6 h-6 flex items-center justify-center rounded-md bg-accent/10 border border-accent/20 text-accent-light text-xs font-bold shrink-0">
                    {step.order}
                  </span>
                  <input
                    value={step.name}
                    onChange={(e) => updateStep(idx, { name: e.target.value })}
                    placeholder="Nome do passo"
                    className={`flex-1 px-3 py-1.5 rounded-lg bg-bg-input border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/10 transition-colors`}
                  />
                  <select
                    value={step.type}
                    onChange={(e) => updateStep(idx, { type: e.target.value as WorkflowStep['type'] })}
                    className="px-2 py-1.5 rounded-lg bg-bg-input border border-border text-text-primary text-xs font-semibold focus:outline-none focus:border-accent transition-colors"
                  >
                    <option value="LOCAL_COMMAND">⚙ Local</option>
                    <option value="REMOTE_SSH_COMMAND">🔗 SSH Remoto</option>
                  </select>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => moveStep(idx, -1)} disabled={idx === 0}
                      className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-card-hover disabled:opacity-30 transition-colors">
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button onClick={() => moveStep(idx, 1)} disabled={idx === steps.length - 1}
                      className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-card-hover disabled:opacity-30 transition-colors">
                      <ChevronDown className="w-4 h-4" />
                    </button>
                    <button onClick={() => removeStep(idx)}
                      className="p-1 rounded text-text-muted hover:text-danger hover:bg-danger/8 transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <textarea
                  value={step.command}
                  onChange={(e) => updateStep(idx, { command: e.target.value })}
                  rows={4}
                  placeholder={step.type === 'LOCAL_COMMAND'
                    ? 'git clone ...\nnpm ci\nnpm run build'
                    : 'cd /app && git pull && docker compose up -d --build'}
                  className="w-full px-3 py-2.5 rounded-lg bg-bg-input border border-border text-text-primary text-xs font-mono placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/10 transition-colors resize-y"
                />
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between pt-4 border-t border-border">
          <p className="text-xs text-text-muted">{steps.length} passo(s) definido(s)</p>
          <button
            onClick={saveWorkflow}
            disabled={savingWorkflow}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-light text-white text-sm font-semibold disabled:opacity-50 transition-colors"
          >
            {savingWorkflow ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Salvar Workflow
          </button>
        </div>
      </div>

      {/* Secrets */}
      <div className="bg-bg-card border border-border rounded-lg p-5">
        <div className="mb-5">
          <h3 className="text-base font-bold text-text-primary">Variáveis de Ambiente (.ENV)</h3>
          <p className="text-sm text-text-secondary mt-0.5">Segredos criptografados com AES-256</p>
        </div>

        <div className="mb-4 flex items-start gap-2 p-3 rounded-lg bg-accent/5 border border-accent/20 text-xs text-text-secondary">
          <Info className="w-4 h-4 text-accent-light shrink-0 mt-0.5" />
          <span>Para passos <strong className="text-text-primary">SSH Remoto</strong>, cadastre obrigatoriamente: <code className="text-accent-light">SSH_HOST</code>, <code className="text-accent-light">SSH_USER</code> e <code className="text-accent-light">SSH_PRIVATE_KEY</code> (ou <code className="text-accent-light">SSH_PASSWORD</code>).</span>
        </div>

        {secrets.length > 0 && (
          <div className="space-y-2 mb-5">
            {secrets.map((secret) => (
              <div key={secret.id} className="flex items-center gap-3 p-3 rounded-lg bg-bg-primary border border-border">
                <code className="text-xs text-accent-light font-mono font-bold min-w-[180px] shrink-0">{secret.keyName}</code>
                <span className="flex-1 text-sm text-text-muted font-mono tracking-widest truncate bg-bg-secondary px-2 py-1 rounded text-xs">
                  {revealedSecrets[secret.id] || '••••••••••••••••••••'}
                </span>
                <button
                  onClick={() => revealSecret(secret.id)}
                  className="p-1.5 rounded-md border border-border text-text-muted hover:text-text-primary hover:bg-bg-card-hover transition-colors"
                >
                  {revealedSecrets[secret.id] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => deleteSecret(secret.id)}
                  className="p-1.5 rounded-md border border-danger/20 text-danger/70 hover:text-danger hover:bg-danger/8 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={addSecret} className="flex gap-3 pt-4 border-t border-border">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/\s/g, '_'))}
            placeholder="CHAVE_MAIUSCULA"
            required
            className="w-1/3 px-3 py-2.5 rounded-lg bg-bg-input border border-border text-text-primary text-xs font-mono font-bold tracking-wider placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/10 transition-colors"
          />
          <input
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="Valor secreto"
            required
            type="password"
            className="flex-1 px-3 py-2.5 rounded-lg bg-bg-input border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/10 transition-colors tracking-widest"
          />
          <button
            type="submit"
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-accent hover:bg-accent-light text-white text-sm font-semibold transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" /> Injetar
          </button>
        </form>
      </div>

      {canDelete && (
        <div className="bg-bg-card border border-danger/30 rounded-lg p-5">
          <div className="mb-4">
            <h3 className="text-base font-bold text-danger">Zona de Perigo</h3>
            <p className="text-sm text-text-secondary mt-0.5">
              Ações irreversíveis. Todo o histórico de deploys, logs e segredos serão permanentemente removidos.
            </p>
          </div>
          <div className="flex items-center justify-between p-4 rounded-lg bg-danger/5 border border-danger/20">
            <div>
              <p className="text-sm font-semibold text-text-primary">Excluir projeto</p>
              <p className="text-xs text-text-muted mt-0.5">Remove o projeto e todos os dados associados</p>
            </div>
            <button
              onClick={onDelete}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-danger/40 text-danger text-sm font-semibold hover:bg-danger hover:text-white hover:border-danger transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              Excluir Projeto
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DeployLogsModal({ deployId, onClose }: { deployId: string; onClose: () => void }) {
  const [deploy, setDeploy] = useState<Deploy | null>(null);
  const [loading, setLoading] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get(`/deploys/${deployId}`)
      .then((res) => setDeploy(res.data.data.deploy))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [deployId]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [deploy]);

  const statusColors: Record<string, string> = {
    SUCCESS:     'text-success',
    FAILED:      'text-danger',
    RUNNING:     'text-accent-light',
    CANCELLED:   'text-warning',
    ROLLED_BACK: 'text-warning',
  };

  const statusLabels: Record<string, string> = {
    ROLLED_BACK: '↩ ROLLED BACK',
  };

  const logs: LogEntry[] = Array.isArray(deploy?.logOutput) ? deploy.logOutput as LogEntry[] : [];

  return createPortal(
    <div
      className="animate-fade-in"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border rounded-xl shadow-2xl w-full max-w-3xl mx-4 flex flex-col animate-slide-up"
        style={{ maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <TerminalIcon className="w-4 h-4 text-accent-light" />
            <div>
              <p className="text-sm font-bold text-text-primary">
                Log do Deploy
                {deploy && (
                  <span className={`ml-2 text-xs font-semibold ${statusColors[deploy.status] || 'text-text-muted'}`}>
                    {statusLabels[deploy.status] ?? deploy.status}
                  </span>
                )}
              </p>
              {deploy?.commitHash && (
                <p className="text-xs text-text-muted font-mono mt-0.5">
                  {deploy.commitHash} · {deploy.commitMsg || '—'} · {deploy.commitAuthorName || deploy.triggeredBy?.name || '—'}
                </p>
              )}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-card-hover transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Log body */}
        <div className="terminal flex-1 overflow-y-auto p-5 text-[13px] font-mono">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="w-6 h-6 text-accent animate-spin" />
            </div>
          ) : logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-center">
              <TerminalIcon className="w-8 h-8 opacity-15 mb-3" />
              <p className="text-sm text-text-muted">
                {deploy?.status === 'RUNNING'
                  ? 'Deploy em execução — acompanhe na aba Terminal.'
                  : 'Logs não disponíveis para este deploy.'}
              </p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {logs.map((log, i) => {
                if (log.type === 'step') {
                  return (
                    <div key={i} className="flex items-center gap-3 my-2 py-1.5 px-2 rounded bg-accent/8 border-l-2 border-accent">
                      <span className="text-accent-light font-bold text-[12px] tracking-wide">{log.message}</span>
                    </div>
                  );
                }
                return (
                  <div key={i} className="flex gap-4 leading-relaxed hover:bg-white/[0.02] px-1 py-0.5 rounded transition-colors">
                    <span className="log-timestamp shrink-0 select-none">
                      [{new Date(log.timestamp).toLocaleTimeString('pt-BR')}]
                    </span>
                    <span className={`log-${log.type} break-all`}>{log.message}</span>
                  </div>
                );
              })}
              <div ref={logsEndRef} className="h-2" />
            </div>
          )}
        </div>

        {/* Footer */}
        {deploy && (
          <div className="px-5 py-3 border-t border-border shrink-0 flex items-center justify-between text-xs text-text-muted">
            <span>{new Date(deploy.createdAt).toLocaleString('pt-BR')}</span>
            {deploy.testsPassed !== null && (
              <span className="flex items-center gap-1.5">
                <FlaskConical className="w-3.5 h-3.5" />
                {deploy.testsPassed}/{deploy.testsTotal} testes passaram
              </span>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
