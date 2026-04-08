import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { Zap, Mail, ArrowLeft, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha ao enviar o email de recuperação');
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
          <h1 className="text-xl font-bold text-text-primary">Recuperar Senha</h1>
          <p className="text-text-secondary text-sm mt-1">Informe seu email para receber o link</p>
        </div>

        <div className="bg-bg-card border border-border rounded-xl p-6 shadow-xl">
          {sent ? (
            <div className="text-center space-y-4 animate-fade-in">
              <CheckCircle2 className="w-12 h-12 text-success mx-auto" />
              <h2 className="font-semibold text-text-primary">Email enviado!</h2>
              <p className="text-text-secondary text-sm">
                Se existe uma conta para <strong className="text-text-primary">{email}</strong>, você receberá o link em breve.
              </p>
              <Link to="/login" className="inline-flex items-center gap-1.5 text-accent-light hover:text-accent text-sm transition-colors">
                <ArrowLeft className="w-4 h-4" /> Voltar ao login
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
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider">Email</label>
                <div className="flex items-center bg-bg-input border border-border rounded-lg focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10 transition-colors group">
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
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg bg-accent hover:bg-accent-light text-white font-semibold text-sm disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
              >
                {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Enviando...</> : 'Enviar Link de Recuperação'}
              </button>
              <Link to="/login" className="flex items-center justify-center gap-1.5 text-text-secondary hover:text-text-primary text-sm transition-colors">
                <ArrowLeft className="w-4 h-4" /> Voltar ao login
              </Link>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
