import { useState, useEffect } from 'react';
import { Rocket, CheckCircle2, XCircle, Clock, GitCommit } from 'lucide-react';
import api from '../../../services/api';

interface ProjectMiniWidgetProps {
  projectId: string;
}

export const ProjectMiniWidget = ({ projectId }: ProjectMiniWidgetProps) => {
  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProject = async () => {
      try {
        const res = await api.get(`/projects/${projectId}`);
        setProject(res.data.data.project);
      } catch (err) {
        console.error('Failed to fetch project for widget', err);
      } finally {
        setLoading(false);
      }
    };
    fetchProject();
    
    // Refresh every 30s for project status
    const interval = setInterval(fetchProject, 30000);
    return () => clearInterval(interval);
  }, [projectId]);

  if (loading) return <div className="animate-pulse h-full bg-bg-secondary/20 rounded-lg" />;
  if (!project) return <div className="text-[10px] text-danger italic">Projeto não encontrado</div>;

  const lastDeploy = project.deploys?.[0];

  return (
    <div className="flex flex-col h-full justify-between py-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
           <div className={`w-2 h-2 rounded-full ${project.status === 'ATIVO' ? 'bg-success animate-pulse' : 'bg-danger'}`} />
           <span className="text-xs font-bold text-text-primary truncate max-w-[100px]">{project.name}</span>
        </div>
        <Rocket className="w-3.5 h-3.5 text-accent-light opacity-50" />
      </div>

      <div className="bg-bg-secondary/40 rounded-lg p-2 border border-border/50">
        <div className="flex items-center gap-2 text-[10px] text-text-secondary truncate mb-1">
           <GitCommit className="w-3 h-3" />
           <span className="font-mono">{lastDeploy?.commitHash?.slice(0, 7) || '---'}</span>
        </div>
        <p className="text-[10px] text-text-muted truncate leading-tight">
          {lastDeploy?.commitMsg || 'Nenhum deploy recente'}
        </p>
      </div>

      <div className="flex items-center justify-between text-[9px] font-bold uppercase tracking-widest text-text-muted">
        <div className="flex items-center gap-1">
          <Clock className="w-2.5 h-2.5" />
          <span>{project._count?.deploys || 0} DEPLOYS</span>
        </div>
        {project.status === 'ATIVO' ? (
          <span className="text-success flex items-center gap-0.5"><CheckCircle2 className="w-2.5 h-2.5" /> ONLINE</span>
        ) : (
          <span className="text-danger flex items-center gap-0.5"><XCircle className="w-2.5 h-2.5" /> OFFLINE</span>
        )}
      </div>
    </div>
  );
};
