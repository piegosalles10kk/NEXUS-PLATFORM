import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import {
  User, Mail, Lock, MapPin, Globe, Key, AlertCircle, Loader2,
  Rocket, Cloud, Server, CheckCircle,
} from 'lucide-react';

// Lista de países (código ISO + nome em PT-BR)
const COUNTRIES = [
  { code: 'BR', name: 'Brasil' },
  { code: 'US', name: 'Estados Unidos' },
  { code: 'PT', name: 'Portugal' },
  { code: 'AR', name: 'Argentina' },
  { code: 'CL', name: 'Chile' },
  { code: 'CO', name: 'Colômbia' },
  { code: 'MX', name: 'México' },
  { code: 'PE', name: 'Peru' },
  { code: 'UY', name: 'Uruguai' },
  { code: 'DE', name: 'Alemanha' },
  { code: 'FR', name: 'França' },
  { code: 'GB', name: 'Reino Unido' },
  { code: 'ES', name: 'Espanha' },
  { code: 'IT', name: 'Itália' },
  { code: 'CA', name: 'Canadá' },
  { code: 'AU', name: 'Austrália' },
  { code: 'JP', name: 'Japão' },
  { code: 'CN', name: 'China' },
  { code: 'IN', name: 'Índia' },
  { code: 'ZA', name: 'África do Sul' },
];

export default function RegisterPage() {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [form, setForm] = useState({
    name:       '',
    email:      '',
    city:       '',
    country:    '',
    password:   '',
    confirm:    '',
    inviteCode: '',
  });
  const [error,   setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (form.password !== form.confirm) {
      setError('As senhas não coincidem.');
      return;
    }
    if (form.password.length < 6) {
      setError('A senha deve ter no mínimo 6 caracteres.');
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/register', {
        name:       form.name,
        email:      form.email,
        city:       form.city || undefined,
        country:    form.country || undefined,
        password:   form.password,
        inviteCode: form.inviteCode || undefined,
      });
      // Auto-login after registration
      await login(form.email, form.password);
      setSuccess(true);
      setTimeout(() => navigate('/dashboard'), 1200);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Erro ao criar conta. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary py-10">
      <div className="w-full max-w-5xl mx-auto px-6 grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">

        {/* Branding */}
        <div className="hidden lg:flex flex-col gap-10 animate-fade-in">
          <div className="flex items-center gap-3">
            <img src="/favicon.svg" alt="Nexus" className="w-10 h-10 rounded-lg object-cover" />
            <span className="text-lg font-bold text-text-primary tracking-widest">NEXUS</span>
          </div>

          <div>
            <h1 className="text-4xl font-bold text-text-primary leading-snug">
              Junte-se à rede.<br />
              <span className="text-accent-light">Compute o futuro.</span>
            </h1>
            <p className="mt-4 text-text-secondary leading-relaxed max-w-sm">
              A plataforma DePIN distribuída onde seu hardware vira infraestrutura.
              Registre nós, deploy apps e ganhe por computação compartilhada.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[
              { icon: Rocket, label: 'Deploy Sem Atrito' },
              { icon: Cloud,  label: 'Rede DePIN Global' },
              { icon: Server, label: 'Hardware Remunerado' },
              { icon: Lock,   label: 'Segredos AES-256' },
            ].map(({ icon: Icon, label }) => (
              <div key={label} className="flex items-center gap-3 px-4 py-3 rounded-lg bg-bg-card border border-border">
                <Icon className="w-4 h-4 text-accent-light shrink-0" />
                <span className="text-sm font-medium text-text-secondary">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Register Panel */}
        <div className="w-full max-w-sm mx-auto animate-slide-up">
          <div className="bg-bg-card border border-border rounded-xl p-8 shadow-xl">

            {/* Mobile logo */}
            <div className="lg:hidden flex items-center gap-3 mb-8">
              <img src="/favicon.svg" alt="Nexus" className="w-8 h-8 rounded-lg object-cover" />
              <span className="font-bold text-text-primary tracking-widest">NEXUS</span>
            </div>

            <div className="mb-7">
              <h2 className="text-xl font-bold text-text-primary">Criar conta</h2>
              <p className="text-sm text-text-secondary mt-1">Preencha os dados para acessar a plataforma</p>
            </div>

            {success ? (
              <div className="flex flex-col items-center gap-4 py-8 text-center animate-fade-in">
                <CheckCircle className="w-12 h-12 text-success" />
                <p className="text-text-primary font-semibold">Conta criada com sucesso!</p>
                <p className="text-sm text-text-secondary">Redirecionando para o dashboard...</p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div className="flex items-center gap-2.5 p-3 rounded-lg bg-danger/8 border border-danger/25 text-danger text-sm animate-fade-in">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                {/* Nome */}
                <Field label="Nome completo">
                  <IconInput icon={<User className="w-4 h-4" />}>
                    <input
                      type="text" value={form.name} onChange={set('name')}
                      placeholder="João da Silva" required minLength={2}
                      className="w-full bg-transparent text-text-primary py-2.5 pr-3 text-sm focus:outline-none placeholder:text-text-muted"
                    />
                  </IconInput>
                </Field>

                {/* Email */}
                <Field label="Email">
                  <IconInput icon={<Mail className="w-4 h-4" />}>
                    <input
                      type="email" value={form.email} onChange={set('email')}
                      placeholder="voce@empresa.com" required
                      className="w-full bg-transparent text-text-primary py-2.5 pr-3 text-sm focus:outline-none placeholder:text-text-muted"
                    />
                  </IconInput>
                </Field>

                {/* Cidade + País */}
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Cidade">
                    <IconInput icon={<MapPin className="w-4 h-4" />}>
                      <input
                        type="text" value={form.city} onChange={set('city')}
                        placeholder="São Paulo"
                        className="w-full bg-transparent text-text-primary py-2.5 pr-3 text-sm focus:outline-none placeholder:text-text-muted"
                      />
                    </IconInput>
                  </Field>

                  <Field label="País">
                    <IconInput icon={<Globe className="w-4 h-4" />}>
                      <select
                        value={form.country} onChange={set('country')}
                        className="w-full bg-transparent text-text-primary py-2.5 pr-3 text-sm focus:outline-none placeholder:text-text-muted appearance-none cursor-pointer"
                      >
                        <option value="">Selecione</option>
                        {COUNTRIES.map(c => (
                          <option key={c.code} value={c.code}>{c.name}</option>
                        ))}
                      </select>
                    </IconInput>
                  </Field>
                </div>

                {/* Senha */}
                <Field label="Senha">
                  <IconInput icon={<Lock className="w-4 h-4" />}>
                    <input
                      type="password" value={form.password} onChange={set('password')}
                      placeholder="••••••••" required minLength={6}
                      className="w-full bg-transparent text-text-primary py-2.5 pr-3 text-sm focus:outline-none placeholder:text-text-muted tracking-widest"
                    />
                  </IconInput>
                </Field>

                {/* Confirmar senha */}
                <Field label="Confirmar senha">
                  <IconInput icon={<Lock className="w-4 h-4" />}>
                    <input
                      type="password" value={form.confirm} onChange={set('confirm')}
                      placeholder="••••••••" required
                      className="w-full bg-transparent text-text-primary py-2.5 pr-3 text-sm focus:outline-none placeholder:text-text-muted tracking-widest"
                    />
                  </IconInput>
                </Field>

                {/* Invite code */}
                <Field label="Código de convite">
                  <IconInput icon={<Key className="w-4 h-4" />}>
                    <input
                      type="text" value={form.inviteCode} onChange={set('inviteCode')}
                      placeholder="NEXUS-XXXXXXXX"
                      className="w-full bg-transparent text-text-primary py-2.5 pr-3 text-sm focus:outline-none placeholder:text-text-muted tracking-wider uppercase"
                    />
                  </IconInput>
                  <p className="text-xs text-text-muted mt-1">
                    Obrigatório para novas contas (exceto o primeiro usuário).
                  </p>
                </Field>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 rounded-lg bg-accent hover:bg-accent-light text-white font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 mt-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Criando conta...
                    </>
                  ) : (
                    'Criar Conta'
                  )}
                </button>

                <p className="text-center text-sm text-text-secondary pt-1">
                  Já tem conta?{' '}
                  <Link to="/login" className="text-accent-light hover:text-accent transition-colors font-medium">
                    Entrar
                  </Link>
                </p>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider">
        {label}
      </label>
      {children}
    </div>
  );
}

function IconInput({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center bg-bg-input border border-border rounded-lg transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10 group">
      <div className="pl-3 pr-2 text-text-muted group-focus-within:text-accent transition-colors shrink-0">
        {icon}
      </div>
      <div className="w-full">
        {children}
      </div>
    </div>
  );
}
