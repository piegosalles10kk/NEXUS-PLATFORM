import { useState, useEffect } from 'react';
import api from '../services/api';
import {
  Settings, Shield, Eye, EyeOff, Save, RotateCcw, CheckCircle2, AlertCircle, Loader2,
  Container,
} from 'lucide-react';

interface SettingInfo {
  key: string;
  label: string;
  description: string;
  isSet: boolean;
  source: 'database' | 'env' | 'unset';
}

function SettingRow({ setting, onSaved }: { setting: SettingInfo; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const save = async () => {
    if (!value.trim()) return;
    setSaving(true);
    setFeedback(null);
    try {
      await api.put(`/settings/${setting.key}`, { value: value.trim() });
      setValue('');
      setFeedback({ type: 'success', msg: 'Salvo com sucesso.' });
      onSaved();
    } catch (err: any) {
      setFeedback({ type: 'error', msg: err.response?.data?.message || 'Falha ao salvar.' });
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!confirm(`Remover "${setting.label}" do banco de dados e voltar ao valor do .env?`)) return;
    setResetting(true);
    setFeedback(null);
    try {
      await api.delete(`/settings/${setting.key}`);
      setFeedback({ type: 'success', msg: 'Resetado para o valor do .env.' });
      onSaved();
    } catch (err: any) {
      setFeedback({ type: 'error', msg: err.response?.data?.message || 'Falha ao resetar.' });
    } finally {
      setResetting(false);
    }
  };

  const sourceLabel =
    setting.source === 'database'
      ? { text: 'Banco de dados', cls: 'bg-success/10 border-success/25 text-success' }
      : setting.source === 'env'
      ? { text: 'Variável de ambiente', cls: 'bg-warning/10 border-warning/25 text-warning' }
      : { text: 'Não configurado', cls: 'bg-danger/10 border-danger/25 text-danger' };

  return (
    <div className="bg-bg-card border border-border rounded-lg p-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="text-sm font-bold text-text-primary">{setting.label}</h3>
            <span className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${sourceLabel.cls}`}>
              {sourceLabel.text}
            </span>
          </div>
          <p className="text-xs text-text-muted">{setting.description}</p>
        </div>
        {setting.source === 'database' && (
          <button
            onClick={reset}
            disabled={resetting}
            title="Remover do banco e usar .env"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-text-secondary text-xs font-semibold hover:text-text-primary hover:bg-bg-card-hover disabled:opacity-50 transition-colors shrink-0"
          >
            {resetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            Resetar
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={setting.isSet ? '••••••••••••  (deixe em branco para manter)' : 'Cole o novo valor aqui'}
            className="w-full px-3 py-2.5 pr-10 rounded-lg bg-bg-input border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/10 transition-colors font-mono"
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
          >
            {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        <button
          onClick={save}
          disabled={saving || !value.trim()}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-accent hover:bg-accent-light text-white text-sm font-semibold disabled:opacity-50 transition-colors shrink-0"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Salvar
        </button>
      </div>

      {feedback && (
        <div className={`mt-3 flex items-center gap-2 text-xs font-medium ${
          feedback.type === 'success' ? 'text-success' : 'text-danger'
        }`}>
          {feedback.type === 'success'
            ? <CheckCircle2 className="w-3.5 h-3.5" />
            : <AlertCircle className="w-3.5 h-3.5" />}
          {feedback.msg}
        </div>
      )}
    </div>
  );
}

// ─── Docker Proxy Permissions ─────────────────────────────────────────────────
interface DockerPermission {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
}

function DockerPermissionsSection() {
  const [permissions, setPermissions] = useState<DockerPermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<Record<string, 'ok' | 'err'>>({});

  const load = async () => {
    try {
      const res = await api.get('/settings/docker-proxy');
      setPermissions(res.data.data.permissions);
    } catch {
      /* silent — proxy section is optional */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggle = async (key: string, current: boolean) => {
    setSaving((p) => ({ ...p, [key]: true }));
    setFeedback((p) => { const n = { ...p }; delete n[key]; return n; });
    try {
      await api.put(`/settings/docker-proxy/${key}`, { enabled: !current });
      setPermissions((prev) => prev.map((p) => p.key === key ? { ...p, enabled: !current } : p));
      setFeedback((p) => ({ ...p, [key]: 'ok' }));
    } catch {
      setFeedback((p) => ({ ...p, [key]: 'err' }));
    } finally {
      setSaving((p) => ({ ...p, [key]: false }));
      setTimeout(() => setFeedback((p) => { const n = { ...p }; delete n[key]; return n; }), 2000);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center py-8">
      <Loader2 className="w-5 h-5 text-accent animate-spin" />
    </div>
  );

  return (
    <div className="space-y-3">
      {permissions.map((perm) => (
        <div key={perm.key} className="bg-bg-card border border-border rounded-lg p-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <p className="text-sm font-semibold text-text-primary">{perm.label}</p>
              {feedback[perm.key] === 'ok' && <CheckCircle2 className="w-3.5 h-3.5 text-success" />}
              {feedback[perm.key] === 'err' && <AlertCircle className="w-3.5 h-3.5 text-danger" />}
            </div>
            <p className="text-xs text-text-muted">{perm.description}</p>
          </div>
          <button
            type="button"
            disabled={saving[perm.key]}
            onClick={() => toggle(perm.key, perm.enabled)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${
              perm.enabled ? 'bg-accent' : 'bg-border'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${perm.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try {
      const res = await api.get('/settings');
      setSettings(res.data.data.settings);
    } catch (err: any) {
      console.error(err);
      setError(err.response?.data?.message || 'Falha ao carregar configurações. Verifique se as migrações do banco foram aplicadas.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="bg-bg-card border border-border rounded-lg p-5">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-accent/10 border border-accent/20">
            <Settings className="w-5 h-5 text-accent-light" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Configurações Globais</h1>
            <p className="text-sm text-text-secondary mt-0.5">
              Valores armazenados no banco têm precedência sobre o <code className="text-accent-light text-xs">.env</code>
            </p>
          </div>
        </div>
      </div>

      {/* Docker Socket Proxy */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Container className="w-4 h-4 text-text-muted" />
          <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Segurança do Docker</h2>
        </div>
        <div className="mb-3 p-4 rounded-lg bg-accent/5 border border-accent/20 text-xs text-text-secondary space-y-1">
          <p className="font-semibold text-text-primary">Docker Socket Proxy ativo</p>
          <p>
            O backend acessa o Docker via <code className="text-accent-light">tcp://docker-proxy:2375</code> (tecnativa/docker-socket-proxy),
            nunca diretamente pelo socket. Desabilite operações específicas abaixo para restringir o acesso em tempo real.
          </p>
        </div>
        <DockerPermissionsSection />
      </div>

      {/* GitHub Integration */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Shield className="w-4 h-4 text-text-muted" />
          <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Integração GitHub</h2>
        </div>

        <div className="mb-3 p-4 rounded-lg bg-accent/5 border border-accent/20 text-xs text-text-secondary space-y-1.5">
          <p className="font-semibold text-text-primary">Como configurar o Webhook no GitHub:</p>
          <ol className="list-decimal list-inside space-y-1 ml-1">
            <li>Acesse o repositório → <strong>Settings</strong> → <strong>Webhooks</strong> → <strong>Add webhook</strong></li>
            <li>Payload URL: <code className="text-accent-light">{'<sua_url>'}/webhook/github</code></li>
            <li>Content type: <code className="text-accent-light">application/json</code></li>
            <li>Secret: cole o mesmo valor configurado abaixo</li>
            <li>Evento: <strong>Just the push event</strong></li>
          </ol>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 text-accent animate-spin" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 p-4 rounded-lg bg-danger/8 border border-danger/25 text-danger text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : (
          <div className="space-y-4">
            {settings.map((s) => (
              <SettingRow key={s.key} setting={s} onSaved={load} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
