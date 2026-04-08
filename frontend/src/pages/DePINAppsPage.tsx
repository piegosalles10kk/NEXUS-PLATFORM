import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Network, Plus, Cpu, Zap, ChevronRight,
  Loader2, AlertCircle, RefreshCw,
} from 'lucide-react';
import api from '../services/api';
import { Card, CardHeader } from '../components/ui/Card';
import { Modal, ModalCancelButton, ModalSubmitButton } from '../components/ui/Modal';

/* ── Types ─────────────────────────────────────────────────── */
interface DePINApp {
  id: string;
  name: string;
  slug: string;
  executionMode: 'WASM' | 'MICROVM';
  replicaCount: number;
  status: string;
  createdAt: string;
  _count?: { assignments: number };
}

/* ── Badge helpers ─────────────────────────────────────────── */
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    RUNNING: 'badge badge-success',
    STOPPED: 'badge badge-neutral',
    DEGRADED: 'badge badge-warning',
    ERROR: 'badge badge-danger',
  };
  return <span className={map[status] ?? 'badge badge-neutral'}>{status}</span>;
}

function ModeBadge({ mode }: { mode: string }) {
  return mode === 'WASM'
    ? <span className="badge badge-info">WASM</span>
    : <span className="badge badge-warning">MicroVM</span>;
}

/* ── Create Modal ──────────────────────────────────────────── */
interface CreateModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (app: DePINApp) => void;
}

function CreateDePINAppModal({ open, onClose, onCreated }: CreateModalProps) {
  const [form, setForm] = useState({
    name: '',
    slug: '',
    executionMode: 'WASM' as 'WASM' | 'MICROVM',
    replicaCount: 1,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Auto-generate slug from name
  const handleNameChange = (name: string) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    setForm(f => ({ ...f, name, slug }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/v1/scheduler/deploy', form);
      onCreated(res.data.data.app);
      onClose();
      setForm({ name: '', slug: '', executionMode: 'WASM', replicaCount: 1 });
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Erro ao criar app.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Novo App DePIN"
      description="Configure como este workload será executado no cluster distribuído."
      footer={
        <>
          <ModalCancelButton onClick={onClose} />
          <ModalSubmitButton label="Criar App" loading={loading} form="create-depin-form" />
        </>
      }
    >
      <form id="create-depin-form" onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-danger/10 border border-danger/20 text-danger text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Nome do App
          </label>
          <input
            className="input-field"
            placeholder="Meu Serviço DePIN"
            value={form.name}
            onChange={e => handleNameChange(e.target.value)}
            required
          />
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Slug (URL)
          </label>
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-text-muted shrink-0">/depin/</span>
            <input
              className="input-field"
              placeholder="meu-servico"
              value={form.slug}
              onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
              pattern="[a-z0-9-]+"
              required
            />
          </div>
          <p className="text-[12px] text-text-muted mt-1">Apenas letras minúsculas, números e hífens.</p>
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-2">
            Modo de Execução
          </label>
          <div className="grid grid-cols-2 gap-3">
            {(['WASM', 'MICROVM'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() => setForm(f => ({ ...f, executionMode: mode }))}
                className={`flex flex-col gap-1.5 p-3.5 rounded-xl border text-left transition-all ${
                  form.executionMode === mode
                    ? 'border-accent bg-accent/10 text-text-primary'
                    : 'border-border bg-bg-input text-text-secondary hover:border-white/10'
                }`}
              >
                {mode === 'WASM'
                  ? <Zap className="w-4 h-4 text-info" />
                  : <Cpu className="w-4 h-4 text-warning" />
                }
                <span className="text-[13px] font-semibold">{mode === 'WASM' ? 'WebAssembly' : 'MicroVM'}</span>
                <span className="text-[11px] leading-snug opacity-70">
                  {mode === 'WASM'
                    ? 'Levíssimo, multi-nó, ideal para APIs'
                    : 'Kernel próprio, isolamento total'}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Réplicas
          </label>
          <input
            type="number"
            min={1}
            max={50}
            className="input-field w-28"
            value={form.replicaCount}
            onChange={e => setForm(f => ({ ...f, replicaCount: Number(e.target.value) }))}
          />
          <p className="text-[12px] text-text-muted mt-1">Número mínimo de nós ativos simultaneamente.</p>
        </div>
      </form>
    </Modal>
  );
}

/* ── Page ──────────────────────────────────────────────────── */
export default function DePINAppsPage() {
  const [apps, setApps] = useState<DePINApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/v1/scheduler/apps');
      setApps(res.data.data.apps ?? []);
    } catch {
      setApps([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Network className="w-5 h-5 text-accent-light" />
            <h1 className="text-2xl font-bold text-text-primary">DePIN — Apps</h1>
          </div>
          <p className="text-[13px] text-text-secondary">
            Workloads distribuídos no cluster de nós físicos.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-white/[0.04] transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-light text-white text-sm font-semibold transition-colors"
          >
            <Plus className="w-4 h-4" />
            Novo App
          </button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 text-accent animate-spin" />
        </div>
      ) : apps.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-24 text-center" padding="none">
          <Network className="w-10 h-10 text-text-muted mb-4" />
          <h3 className="text-base font-semibold text-text-primary mb-1">Nenhum app ainda</h3>
          <p className="text-[13px] text-text-secondary max-w-xs mb-6">
            Crie seu primeiro workload DePIN e distribua-o pelos nós do cluster.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-light text-white text-sm font-semibold transition-colors"
          >
            <Plus className="w-4 h-4" />
            Criar primeiro app
          </button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {apps.map((app, i) => (
            <Card
              key={app.id}
              hoverable
              onClick={() => navigate(`/depin/${app.id}`)}
              className={`stagger-${Math.min(i + 1, 4)}`}
            >
              <CardHeader
                title={app.name}
                description={`/depin/${app.slug}`}
                action={<StatusBadge status={app.status} />}
              />

              <div className="flex items-center gap-3 flex-wrap mt-1">
                <ModeBadge mode={app.executionMode} />
                <span className="text-[12px] text-text-muted">
                  {app._count?.assignments ?? 0} nós atribuídos
                </span>
                <span className="text-[12px] text-text-muted">
                  {app.replicaCount} réplica{app.replicaCount !== 1 ? 's' : ''}
                </span>
              </div>

              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <span className="text-[12px] text-text-muted">
                  {new Date(app.createdAt).toLocaleDateString('pt-BR')}
                </span>
                <ChevronRight className="w-4 h-4 text-text-muted" />
              </div>
            </Card>
          ))}
        </div>
      )}

      <CreateDePINAppModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={app => setApps(prev => [app, ...prev])}
      />
    </div>
  );
}
