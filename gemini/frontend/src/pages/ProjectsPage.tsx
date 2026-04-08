import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import {
  FolderGit2, Cloud, CheckCircle2, XCircle, PauseCircle,
  GitCommit, FlaskConical, TrendingUp, Activity, Rocket,
  Plus, Loader2, Monitor, X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

interface Project {
  id: string;
  name: string;
  repoUrl: string;
  branchTarget: string;
  environmentType: 'LOCAL' | 'CLOUD';
  status: 'ATIVO' | 'FALHOU' | 'PAUSADO';
  deploys: Array<{
    id: string;
    commitHash: string | null;
    commitMsg: string | null;
    status: string;
    testsPassed: number | null;
    testsTotal: number | null;
    createdAt: string;
  }>;
  _count: { secrets: number; deploys: number };
}

interface Stats {
  projects: { total: number; active: number; failed: number; paused: number };
  deploys: { today: number; successRate: number };
}

const envIcons: Record<string, React.ReactNode> = {
  LOCAL: <Monitor className="w-4 h-4" />,
  CLOUD: <Cloud className="w-4 h-4" />,
};

const statusConfig = {
  ATIVO: { icon: CheckCircle2, color: 'text-success', bg: 'bg-success/8', border: 'border-success/20', dot: 'bg-success', label: 'Ativo' },
  FALHOU: { icon: XCircle, color: 'text-danger', bg: 'bg-danger/8', border: 'border-danger/20', dot: 'bg-danger', label: 'Falhou' },
  PAUSADO: { icon: PauseCircle, color: 'text-warning', bg: 'bg-warning/8', border: 'border-warning/20', dot: 'bg-warning', label: 'Pausado' },
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const { hasRole } = useAuth();
  const navigate = useNavigate();

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const [projectsRes, statsRes] = await Promise.all([
        api.get('/projects'),
        api.get('/projects/stats'),
      ]);
      setProjects(projectsRes.data.data.projects);
      setStats(statsRes.data.data);
    } catch (err) {
      console.error('Falha ao buscar dados:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Projetos Orchestrados</h1>
          <p className="text-text-secondary text-sm mt-1">Gerencie seu pipeline de integração e entrega contínua</p>
        </div>
        {hasRole('ADM', 'TECNICO') && (
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-light text-white font-semibold text-sm transition-colors"
          >
            <Plus className="w-4 h-4" />
            Novo Projeto
          </button>
        )}
      </div>

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: 'Total de Projetos', value: stats.projects.total, icon: FolderGit2, color: 'text-accent-light' },
            { label: 'Projetos Ativos', value: stats.projects.active, icon: Activity, color: 'text-success' },
            { label: 'Deploys Hoje', value: stats.deploys.today, icon: Rocket, color: 'text-accent-light' },
            {
              label: 'Taxa de Sucesso',
              value: stats.projects.total === 0 ? '—' : `${stats.deploys.successRate}%`,
              icon: TrendingUp,
              color: 'text-success',
            },
          ].map((stat, i) => (
            <div
              key={stat.label}
              className={`bg-bg-card border border-border rounded-lg p-6 stagger-${i + 1} animate-slide-up`}
            >
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider">{stat.label}</p>
                <stat.icon className={`w-5 h-5 ${stat.color}`} />
              </div>
              <p className="text-3xl font-bold text-text-primary">{stat.value}</p>
            </div>
          ))}
        </div>
      )}

      <div>
        {projects.length === 0 ? (
          <div className="bg-bg-card border border-border rounded-lg p-16 flex flex-col items-center justify-center text-center">
            <FolderGit2 className="w-10 h-10 text-text-secondary mb-4" />
            <h3 className="text-lg font-semibold text-text-primary mb-2">Nenhum projeto cadastrado</h3>
            <p className="text-text-secondary text-sm mb-6 max-w-sm">
              Inicialize seu pipeline configurando seu primeiro repositório.
            </p>
            {hasRole('ADM', 'TECNICO') && (
              <button
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-light text-white font-semibold text-sm transition-colors"
              >
                <Plus className="w-4 h-4" />
                Criar Primeiro Projeto
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {projects.map((project, i) => {
              const status = statusConfig[project.status];
              const lastDeploy = project.deploys[0];
              const testsPassed = lastDeploy?.testsPassed ?? 0;
              const testsTotal = lastDeploy?.testsTotal ?? 0;
              const testPercent = testsTotal > 0 ? (testsPassed / testsTotal) * 100 : 0;

              return (
                <div
                  key={project.id}
                  onClick={() => navigate(`/project/${project.id}`)}
                  className={`bg-bg-card border border-border rounded-lg p-5 cursor-pointer hover:bg-bg-card-hover hover:border-border transition-all group stagger-${(i % 4) + 1} animate-slide-up`}
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-accent/8 border border-border flex items-center justify-center">
                        <FolderGit2 className="w-4 h-4 text-accent-light" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-text-primary group-hover:text-accent-light transition-colors">
                          {project.name}
                        </h3>
                        <div className="flex items-center gap-1.5 text-xs text-text-muted mt-0.5">
                          {envIcons[project.environmentType]}
                          <span>{project.environmentType}</span>
                        </div>
                      </div>
                    </div>
                    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-semibold ${status.bg} ${status.color} border ${status.border}`}>
                      <div className={`w-1.5 h-1.5 rounded-full ${status.dot} ${project.status === 'ATIVO' ? 'animate-pulse-status' : ''}`} />
                      {status.label}
                    </div>
                  </div>

                  <div className="mb-4">
                    {lastDeploy ? (
                      <div className="flex items-center gap-2 p-2.5 rounded-md bg-bg-primary border border-border text-xs">
                        <GitCommit className="w-3.5 h-3.5 text-accent-light shrink-0" />
                        <div className="min-w-0">
                          <code className="text-accent-light font-mono block">{lastDeploy.commitHash?.slice(0, 7) || '—'}</code>
                          <span className="text-text-secondary truncate block">{lastDeploy.commitMsg || 'Sem info de commit'}</span>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-text-muted italic p-2">Nenhum deploy realizado</p>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <div className="flex items-center gap-1.5 text-text-muted">
                        <FlaskConical className="w-3.5 h-3.5" />
                        <span>Testes</span>
                      </div>
                      <span className={`font-mono font-semibold ${testPercent === 100 ? 'text-success' : testPercent > 0 ? 'text-warning' : 'text-text-muted'}`}>
                        {testsPassed}/{testsTotal}
                      </span>
                    </div>
                    <div className="w-full h-1 rounded-full bg-bg-primary overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${testPercent === 100 ? 'bg-success' : testPercent > 0 ? 'bg-warning' : 'bg-text-muted'}`}
                        style={{ width: `${testPercent}%` }}
                      />
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-border flex items-center justify-between text-xs text-text-muted">
                    <span className="flex items-center gap-1"><Rocket className="w-3.5 h-3.5" /> {project._count.deploys} deploys</span>
                    <span className="flex items-center gap-1"><GitCommit className="w-3.5 h-3.5" /> {project.branchTarget}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showCreateModal && (
        <CreateProjectModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => { setShowCreateModal(false); loadData(); }}
        />
      )}
    </div>
  );
}

function CreateProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [envType, setEnvType] = useState('LOCAL');
  const [nodes, setNodes] = useState<any[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchNodes = async () => {
      setLoadingNodes(true);
      try {
        const res = await api.get('/v1/agent/nodes');
        setNodes(res.data.data.nodes);
      } catch (err) {
        console.error('Falha ao carregar nodes:', err);
      } finally {
        setLoadingNodes(false);
      }
    };
    fetchNodes();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    // Determine the environment type and nodeId
    let finalEnvType = envType;
    let nodeId = null;

    if (envType !== 'LOCAL' && envType !== 'CLOUD') {
      finalEnvType = 'NODE';
      nodeId = envType; // The value is the nodeId
    }

    try {
      await api.post('/projects', { 
        name, 
        repoUrl, 
        branchTarget: branch, 
        environmentType: finalEnvType,
        nodeId
      });
      onCreated();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha ao criar o projeto');
    } finally {
      setLoading(false);
    }
  };

  const inputClass = 'w-full px-3 py-2.5 rounded-lg bg-bg-input border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/10 transition-colors';

  return createPortal(
    <div
      className="animate-fade-in"
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.65)' }}
      onClick={onClose}
    >
      <div className="bg-bg-card border border-border rounded-xl p-6 w-full max-w-lg animate-slide-up shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-bold text-text-primary">Novo Projeto</h2>
            <p className="text-sm text-text-secondary mt-0.5">Configure o repositório para orquestração</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-card-hover transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-danger/8 border border-danger/25 text-danger text-sm flex items-center gap-2">
            <XCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Nome do Projeto</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required
              className={inputClass} placeholder="Meu Projeto" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">URL do Repositório (Git)</label>
            <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} required
              className={inputClass} placeholder="https://github.com/usuario/repo.git" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Branch</label>
              <input value={branch} onChange={(e) => setBranch(e.target.value)}
                className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Ambiente de Destino</label>
              <select 
                value={envType} 
                onChange={(e) => setEnvType(e.target.value)} 
                className={inputClass}
                disabled={loadingNodes}
              >
                <optgroup label="Infraestrutura Nexus">
                  <option value="LOCAL">Servidor Local (Nexus Principal)</option>
                  <option value="CLOUD">Cloud (Universal / SSH)</option>
                </optgroup>
                {nodes.length > 0 && (
                  <optgroup label="Agentes Conectados">
                    {nodes.map(node => (
                      <option key={node.id} value={node.id}>
                        {node.name} ({node.status})
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          </div>
          <div className="flex gap-3 pt-2 border-t border-border mt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-lg border border-border text-text-primary text-sm font-semibold hover:bg-bg-card-hover transition-colors">
              Cancelar
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 py-2.5 rounded-lg bg-accent hover:bg-accent-light text-white text-sm font-semibold disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Criar Projeto
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
