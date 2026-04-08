import { useState } from 'react';
import { 
  X, Zap, CheckCircle2, 
  Terminal, Globe, Cpu, AlertTriangle, 
  RefreshCw, Info, Code, Save, Layers
} from 'lucide-react';
import api from '../services/api';

interface WorkflowStep {
  name: string;
  order: number;
  type: 'LOCAL_COMMAND' | 'REMOTE_SSH_COMMAND';
  command: string;
}

interface AIAnalysisResult {
  framework: string;
  language: string;
  suggestions: {
    port: number;
    buildCommand?: string;
    startCommand?: string;
    dockerfile?: string;
    envVars?: string[];
    workflowSteps: WorkflowStep[];
  };
  description: string;
}

interface AIAnalysisModalProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  onApplied: () => void;
  analysis: AIAnalysisResult;
}

export default function AIAnalysisModal({ projectId, isOpen, onClose, onApplied, analysis }: AIAnalysisModalProps) {
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  if (!isOpen) return null;

  const handleApply = async () => {
    setApplying(true);
    try {
      // 1. Update Project basic config (port)
      await api.put(`/projects/${projectId}`, {
        proxyPort: analysis.suggestions.port,
        envVars: analysis.suggestions.envVars
      });

      // 2. Save Workflow Steps
      if (analysis.suggestions.workflowSteps.length > 0) {
        await api.put(`/projects/${projectId}/workflow`, {
          steps: analysis.suggestions.workflowSteps
        });
      }

      // 3. (Future) Handle Dockerfile if requested
      
      setApplied(true);
      setTimeout(() => {
        onApplied();
        onClose();
      }, 1500);
    } catch (err) {
      alert('Falha ao aplicar sugestões.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-bg-card border border-border w-full max-w-4xl max-h-[90vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-scale-in">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-border bg-gradient-to-r from-accent/10 to-transparent flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-accent/20 rounded-xl text-accent-light animate-pulse shadow-[0_0_15px_rgba(var(--color-primary),0.3)]">
              <Zap className="w-5 h-5 fill-current" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-text-primary tracking-tight">Análise Inteligente Nexus</h2>
              <p className="text-xs text-text-muted">Sugestões do Gemini para seu repositório</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-2 rounded-full hover:bg-bg-secondary text-text-muted hover:text-text-primary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar bg-bg-card">
          
          {/* Summary */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl bg-bg-secondary/50 border border-border flex items-center gap-4 group hover:border-accent/30 transition-colors">
              <div className="p-3 bg-accent/10 rounded-lg text-accent shrink-0 group-hover:scale-110 transition-transform">
                <Globe className="w-5 h-5" />
              </div>
              <div>
                <p className="text-[10px] text-text-muted uppercase font-bold tracking-widest">Linguagem</p>
                <p className="text-sm font-bold text-text-primary">{analysis.language}</p>
              </div>
            </div>
            
            <div className="p-4 rounded-xl bg-bg-secondary/50 border border-border flex items-center gap-4 group hover:border-accent/30 transition-colors">
              <div className="p-3 bg-accent/10 rounded-lg text-accent shrink-0 group-hover:scale-110 transition-transform">
                <Layers className="w-5 h-5" />
              </div>
              <div>
                <p className="text-[10px] text-text-muted uppercase font-bold tracking-widest">Framework</p>
                <p className="text-sm font-bold text-text-primary">{analysis.framework}</p>
              </div>
            </div>
            
            <div className="p-4 rounded-xl bg-bg-secondary/50 border border-border flex items-center gap-4 group hover:border-accent/30 transition-colors">
              <div className="p-3 bg-accent/10 rounded-lg text-accent shrink-0 group-hover:scale-110 transition-transform">
                <Cpu className="w-5 h-5" />
              </div>
              <div>
                <p className="text-[10px] text-text-muted uppercase font-bold tracking-widest">Porta Sugerida</p>
                <p className="text-sm font-bold text-text-primary">{analysis.suggestions.port}</p>
              </div>
            </div>
          </div>

          {/* Description */}
          <div className="p-4 rounded-xl bg-accent/5 border border-accent/20 relative overflow-hidden group">
            <div className="absolute right-[-20px] top-[-20px] opacity-[0.03] group-hover:opacity-[0.05] transition-opacity">
               <Zap className="w-24 h-24 stroke-[4]" />
            </div>
            <div className="flex gap-4">
              <Info className="w-5 h-5 text-accent shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-bold text-accent-light mb-1">Análise do Gemini</h4>
                <p className="text-sm text-text-secondary leading-relaxed italic">{analysis.description}</p>
              </div>
            </div>
          </div>

          {/* Workflow Steps */}
          {analysis.suggestions.workflowSteps.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-2">
                <Terminal className="w-4 h-4 text-accent" />
                <h4 className="text-[11px] uppercase tracking-[0.2em] font-black text-text-muted">Workflow Personalizado</h4>
              </div>
              
              <div className="space-y-3">
                {analysis.suggestions.workflowSteps.map((step, i) => (
                  <div key={i} className="flex items-start gap-4 p-4 rounded-xl bg-bg-secondary/30 border border-border/50 group hover:bg-bg-secondary/50 hover:border-accent/20 transition-all">
                    <div className="w-6 h-6 flex items-center justify-center rounded-full bg-accent text-[10px] font-bold text-black shrink-0 mt-1 shadow-lg shadow-accent/20">
                      {step.order}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-4 mb-2">
                         <h5 className="text-sm font-bold text-text-primary truncate">{step.name}</h5>
                         <span className="text-[9px] px-2 py-0.5 rounded bg-bg-primary text-text-muted border border-border uppercase font-mono">{step.type}</span>
                      </div>
                      <code className="block p-3 rounded-lg bg-black/40 text-xs text-text-secondary font-mono border border-white/5 break-all">
                        {step.command}
                      </code>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Dockerfile Sugerido (if any) */}
          {analysis.suggestions.dockerfile && (
             <div className="space-y-4">
               <div className="flex items-center gap-3 mb-2">
                 <Code className="w-4 h-4 text-accent" />
                 <h4 className="text-[11px] uppercase tracking-[0.2em] font-black text-text-muted">Dockerfile Sugerido</h4>
               </div>
               <div className="relative group">
                 <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[10px] text-text-muted bg-bg-card p-1 rounded border border-border">Preview</span>
                 </div>
                 <pre className="p-4 rounded-xl bg-black/60 border border-border font-mono text-[11px] text-text-secondary overflow-x-auto max-h-60 custom-scrollbar leading-relaxed">
                   {analysis.suggestions.dockerfile}
                 </pre>
               </div>
             </div>
          )}

          {/* Environment Variables */}
          {analysis.suggestions.envVars && analysis.suggestions.envVars.length > 0 && (
            <div className="p-4 rounded-xl bg-warning/5 border border-warning/10 border-dashed">
              <div className="flex items-center gap-3 mb-3">
                <AlertTriangle className="w-4 h-4 text-warning" />
                 <h4 className="text-[11px] uppercase tracking-[0.2em] font-black text-warning/80">Variáveis Detectadas</h4>
              </div>
              <div className="flex flex-wrap gap-2">
                {analysis.suggestions.envVars.map((v, i) => (
                  <span key={i} className="px-2.5 py-1 rounded-md bg-bg-primary border border-border/50 text-[11px] font-mono text-text-secondary">
                    {v}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-[10px] text-text-muted italic flex items-center gap-2">
                <Info className="w-3 h-3" />
                Lembre-se de configurar essas chaves em "Configurações {' > '} Segredos" após aplicar.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-5 border-t border-border bg-bg-secondary flex items-center justify-between gap-4">
          <p className="text-[10px] text-text-muted max-w-[50%] hidden sm:block">
            Ao aplicar, a Nexus atualizará a porta do container e criará os passos de workflow recomendados.
          </p>
          
          <div className="flex items-center gap-3 ml-auto">
            <button 
              onClick={onClose}
              className="px-5 py-2.5 rounded-xl hover:bg-bg-primary text-text-secondary text-sm font-bold transition-all"
            >
              Descartar
            </button>
            <button 
              onClick={handleApply}
              disabled={applying || applied}
              className={`px-8 py-2.5 rounded-xl flex items-center gap-3 text-sm font-bold transition-all shadow-xl hover:shadow-2xl active:scale-95 disabled:opacity-50
                ${applied ? 'bg-success text-black' : 'bg-accent text-black hover:bg-accent-light'}`}
            >
              {applying ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" /> Aplicando...
                </>
              ) : applied ? (
                <>
                  <CheckCircle2 className="w-4 h-4" /> Aplicado!
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" /> Aplicar Configurações
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
