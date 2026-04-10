import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Mail, Lock, AlertCircle, Loader2, Rocket, Cloud, Server } from 'lucide-react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const loggedUser = await login(email, password);
      navigate(loggedUser.role === 'ADM' ? '/admin' : '/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha no login. Verifique suas credenciais.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary">
      <div className="w-full max-w-5xl mx-auto px-6 grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">

        {/* Branding */}
        <div className="hidden lg:flex flex-col gap-10 animate-fade-in">
          <div className="flex items-center gap-3">
            <img src="/favicon.svg" alt="Nexus" className="w-10 h-10 rounded-lg object-cover" />
            <span className="text-lg font-bold text-text-primary tracking-widest">NEXUS</span>
          </div>

          <div>
            <h1 className="text-4xl font-bold text-text-primary leading-snug">
              Entregue rápido.<br />
              <span className="text-accent-light">Domine seu pipeline.</span>
            </h1>
            <p className="mt-4 text-text-secondary leading-relaxed max-w-sm">
              Plataforma de orquestração local de CI/CD com deploys sem atrito e controle de acesso granular.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[
              { icon: Rocket, label: 'DooD Automatizado' },
              { icon: Cloud, label: 'Deploy em Cloud Universal' },
              { icon: Server, label: 'Logs em Tempo Real' },
              { icon: Lock, label: 'Segredos AES-256' },
            ].map(({ icon: Icon, label }) => (
              <div key={label} className="flex items-center gap-3 px-4 py-3 rounded-lg bg-bg-card border border-border">
                <Icon className="w-4 h-4 text-accent-light shrink-0" />
                <span className="text-sm font-medium text-text-secondary">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Login Panel */}
        <div className="w-full max-w-sm mx-auto animate-slide-up">
          <div className="bg-bg-card border border-border rounded-xl p-8 shadow-xl">

            {/* Mobile logo */}
            <div className="lg:hidden flex items-center gap-3 mb-8">
              <img src="/favicon.svg" alt="Nexus" className="w-8 h-8 rounded-lg object-cover" />
              <span className="font-bold text-text-primary tracking-widest">NEXUS</span>
            </div>

            <div className="mb-7">
              <h2 className="text-xl font-bold text-text-primary">Bem-vindo de volta</h2>
              <p className="text-sm text-text-secondary mt-1">Acesse sua plataforma de deploy</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <div className="flex items-center gap-2.5 p-3 rounded-lg bg-danger/8 border border-danger/25 text-danger text-sm animate-fade-in">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider">
                  Email
                </label>
                <div className="flex items-center bg-bg-input border border-border rounded-lg transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10 group">
                  <div className="pl-3 pr-2 text-text-muted group-focus-within:text-accent transition-colors">
                    <Mail className="w-4 h-4" />
                  </div>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="voce@empresa.com"
                    required
                    className="w-full bg-transparent text-text-primary py-2.5 pr-3 text-sm focus:outline-none placeholder:text-text-muted"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider">
                  Senha
                </label>
                <div className="flex items-center bg-bg-input border border-border rounded-lg transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10 group">
                  <div className="pl-3 pr-2 text-text-muted group-focus-within:text-accent transition-colors">
                    <Lock className="w-4 h-4" />
                  </div>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    className="w-full bg-transparent text-text-primary py-2.5 pr-3 text-sm focus:outline-none placeholder:text-text-muted tracking-widest"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="w-3.5 h-3.5 rounded border-border bg-bg-input accent-accent" />
                  <span className="text-sm text-text-secondary">Lembrar-me</span>
                </label>
                <Link
                  to="/forgot-password"
                  className="text-sm text-accent-light hover:text-accent transition-colors"
                >
                  Esqueceu a senha?
                </Link>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg bg-accent hover:bg-accent-light text-white font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 mt-1"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Autenticando...
                  </>
                ) : (
                  'Entrar na Plataforma'
                )}
              </button>

              <p className="text-center text-sm text-text-secondary pt-1">
                Não tem conta?{' '}
                <Link
                  to="/register"
                  className="text-accent-light hover:text-accent transition-colors font-medium"
                >
                  Criar conta
                </Link>
              </p>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
