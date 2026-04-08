import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Monitor, Rocket, Plus, Loader2 } from 'lucide-react';
import api from '../../services/api';

interface AddWidgetModalProps {
  onClose: () => void;
  onAdd: (widget: any) => void;
}

export const AddWidgetModal = ({ onClose, onAdd }: AddWidgetModalProps) => {
  const [step, setStep] = useState(1);
  const [type, setType] = useState<string | null>(null);
  const [nodes, setNodes] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [nodesRes, projectsRes] = await Promise.all([
          api.get('/v1/agent/nodes'),
          api.get('/projects'),
        ]);
        setNodes(nodesRes.data.data.nodes);
        setProjects(projectsRes.data.data.projects);
      } catch (err) {
        console.error('Failed to fetch data for modal', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const widgetTypes = [
    { id: 'SERVER_CARD', name: 'Servidor Completo', icon: Monitor, color: 'text-accent', description: 'Painel unificado com CPU, RAM, HD e Rede' },
    { id: 'PROJECT_STATUS', name: 'Status de Projeto', icon: Rocket, color: 'text-accent-light', description: 'Acompanhamento compacto de um projeto' },
  ];

  const handleSelectType = (selectedType: string) => {
    setType(selectedType);
    setStep(2);
  };

  const handleConfirm = () => {
    if (!type || !selectedTarget) return;

    const targetName = type.startsWith('SERVER_') 
      ? nodes.find(n => n.id === selectedTarget)?.name 
      : projects.find(p => p.id === selectedTarget)?.name;

    const widget = {
      type,
      title: targetName || widgetTypes.find(t => t.id === type)?.name || 'Novo Widget',
      settings: type.startsWith('SERVER_') ? { nodeId: selectedTarget } : { projectId: selectedTarget },
      w: type === 'SERVER_CARD' ? 2 : 1,
      h: type === 'SERVER_CARD' ? 2 : 1,
    };

    onAdd(widget);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in px-4"
      onClick={onClose}
    >
      <div 
        className="bg-bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl animate-slide-up overflow-hidden" 
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-bg-secondary/20">
          <div>
            <h2 className="text-lg font-bold text-text-primary">Adicionar Widget</h2>
            <p className="text-xs text-text-muted mt-0.5">Personalize o seu painel de controle</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-card-hover transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          {step === 1 && (
            <div className="grid grid-cols-1 gap-3">
              {widgetTypes.map((t) => (
                <button
                  key={t.id}
                  onClick={() => handleSelectType(t.id)}
                  className="flex items-start gap-4 p-4 rounded-xl bg-bg-input border border-border hover:bg-bg-card-hover hover:border-accent/40 text-left transition-all group"
                >
                  <div className={`p-2.5 rounded-lg bg-bg-secondary border border-border group-hover:border-accent/30 ${t.color}`}>
                    <t.icon className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-text-primary">{t.name}</h3>
                    <p className="text-xs text-text-muted mt-0.5">{t.description}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4 animate-fade-in">
              <label className="block text-xs font-bold text-text-secondary uppercase tracking-widest mb-1.5">
                {type?.startsWith('SERVER_') ? 'Selecionar Servidor' : 'Selecionar Projeto'}
              </label>
              
              {loading ? (
                <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 text-accent animate-spin" /></div>
              ) : (
                <div className="max-h-[300px] overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                  {(type?.startsWith('SERVER_') ? nodes : projects).map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setSelectedTarget(item.id)}
                      className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all ${
                        selectedTarget === item.id 
                          ? 'bg-accent/10 border-accent text-accent-light shadow-[0_0_15px_rgba(99,102,241,0.1)]' 
                          : 'bg-bg-input border-border text-text-primary hover:bg-bg-card-hover'
                      }`}
                    >
                      <span className="text-sm font-semibold">{item.name}</span>
                      {selectedTarget === item.id && <div className="w-2 h-2 rounded-full bg-accent" />}
                    </button>
                  ))}
                  {(type?.startsWith('SERVER_') ? nodes : projects).length === 0 && (
                    <p className="text-center text-xs text-text-muted py-8 italic">Nenhum alvo encontrado.</p>
                  )}
                </div>
              )}

              <div className="flex gap-3 pt-6 border-t border-border mt-4">
                <button
                  onClick={() => setStep(1)}
                  className="flex-1 py-1 px-4 rounded-xl border border-border text-text-secondary text-sm font-bold hover:bg-bg-card-hover transition-colors"
                >
                  Voltar
                </button>
                <button
                  disabled={!selectedTarget}
                  onClick={handleConfirm}
                  className="flex-3 py-3 px-6 rounded-xl bg-accent hover:bg-accent-light text-white text-sm font-bold disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Adicionar ao Painel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
