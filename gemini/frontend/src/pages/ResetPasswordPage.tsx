import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../services/api';
import { Zap, Lock, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('As senhas não coincidem');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha ao redefinir. Token pode ter expirado.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary">
      <div className="w-full max-w-sm px-6 animate-slide-up">

        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-accent/10 border border-accent/25 mb-4">
            <Zap className="w-5 h-5 text-accent" />
          </div>
          <h1 className="text-xl font-bold text-text-primary">Nova Senha</h1>
          <p className="text-text-secondary text-sm mt-1">Escolha uma senha forte</p>
        </div>

        <div className="bg-bg-card border border-border rounded-xl p-6 shadow-xl">
          {success ? (
            <div className="text-center space-y-4 animate-fade-in">
              <CheckCircle2 className="w-12 h-12 text-success mx-auto" />
              <h2 className="font-semibold text-text-primary">Senha redefinida!</h2>
              <p className="text-text-secondary text-sm">Sua senha foi alterada com sucesso.</p>
              <Link to="/login" className="inline-block py-2.5 px-6 rounded-lg bg-accent hover:bg-accent-light text-white font-semibold text-sm transition-colors">
                Ir para o Login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-danger/8 border border-danger/25 text-danger text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" /> {error}
                </div>
              )}
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider">Nova Senha</label>
                <div className="flex items-center bg-bg-input border border-border rounded-lg focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10 transition-colors group">
                  <div className="pl-3 pr-2 text-text-muted group-focus-within:text-accent transition-colors">
                    <Lock className="w-4 h-4" />
                  </div>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={6}
                    className="w-full bg-transparent text-text-primary py-2.5 pr-3 text-sm focus:outline-none placeholder:text-text-muted tracking-widest"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider">Confirmar Senha</label>
                <div className="flex items-center bg-bg-input border border-border rounded-lg focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10 transition-colors group">
                  <div className="pl-3 pr-2 text-text-muted group-focus-within:text-accent transition-colors">
                    <Lock className="w-4 h-4" />
                  </div>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={6}
                    className="w-full bg-transparent text-text-primary py-2.5 pr-3 text-sm focus:outline-none placeholder:text-text-muted tracking-widest"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg bg-accent hover:bg-accent-light text-white font-semibold text-sm disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
              >
                {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Redefinindo...</> : 'Redefinir Senha'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
