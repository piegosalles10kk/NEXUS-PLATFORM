import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import api from '../services/api';
import {
  Users, Plus, Trash2, Edit, Shield, Loader2, AlertCircle, X, Check,
} from 'lucide-react';

interface User {
  id: string;
  name: string;
  email: string;
  role: 'ADM' | 'TECNICO' | 'OBSERVADOR';
  createdAt: string;
}

const roleConfig: Record<string, { label: string; class: string }> = {
  ADM: { label: 'ADM', class: 'bg-accent/10 text-accent-light border-accent/20' },
  TECNICO: { label: 'TÉCNICO', class: 'bg-success/10 text-success border-success/20' },
  OBSERVADOR: { label: 'OBSERVADOR', class: 'bg-warning/10 text-warning border-warning/20' },
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { loadUsers(); }, []);

  const loadUsers = async () => {
    try {
      const res = await api.get('/users');
      setUsers(res.data.data.users);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const deleteUser = async (id: string) => {
    if (!confirm('Remover este usuário permanentemente?')) return;
    try {
      await api.delete(`/users/${id}`);
      loadUsers();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha ao remover o usuário.');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
            <Users className="w-6 h-6 text-accent-light" />
            Gestão de Usuários
          </h1>
          <p className="text-text-secondary text-sm mt-1">Administre credenciais e permissões do ecossistema</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-light text-white font-semibold text-sm transition-colors"
        >
          <Plus className="w-4 h-4" /> Adicionar Usuário
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-danger/8 border border-danger/25 text-danger text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="p-1 hover:bg-danger/15 rounded transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-border bg-bg-secondary">
              <th className="py-3 px-5 text-[11px] font-semibold text-text-muted uppercase tracking-wider">Usuário</th>
              <th className="py-3 px-5 text-[11px] font-semibold text-text-muted uppercase tracking-wider">Email</th>
              <th className="py-3 px-5 text-[11px] font-semibold text-text-muted uppercase tracking-wider">Nível de Acesso</th>
              <th className="py-3 px-5 text-[11px] font-semibold text-text-muted uppercase tracking-wider">Cadastro</th>
              <th className="py-3 px-5 text-right text-[11px] font-semibold text-text-muted uppercase tracking-wider">Ações</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const rc = roleConfig[user.role];
              return (
                <tr key={user.id} className="border-b border-border last:border-0 hover:bg-bg-card-hover transition-colors">
                  <td className="py-3.5 px-5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-accent/8 border border-border flex items-center justify-center text-sm font-bold text-accent-light shrink-0">
                        {user.name.charAt(0).toUpperCase()}
                      </div>
                      <span className="text-sm font-semibold text-text-primary">{user.name}</span>
                    </div>
                  </td>
                  <td className="py-3.5 px-5 text-sm text-text-secondary">{user.email}</td>
                  <td className="py-3.5 px-5">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border ${rc.class}`}>
                      <Shield className="w-3 h-3" />
                      {rc.label}
                    </span>
                  </td>
                  <td className="py-3.5 px-5 text-sm text-text-muted">
                    {new Date(user.createdAt).toLocaleDateString('pt-BR')}
                  </td>
                  <td className="py-3.5 px-5">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setEditingUser(user)}
                        className="p-1.5 rounded-md text-text-muted hover:text-accent-light hover:bg-accent/8 transition-colors"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => deleteUser(user.id)}
                        className="p-1.5 rounded-md text-text-muted hover:text-danger hover:bg-danger/8 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <UserModal mode="create" onClose={() => setShowCreate(false)} onSuccess={() => { setShowCreate(false); loadUsers(); }} />
      )}
      {editingUser && (
        <UserModal mode="edit" user={editingUser} onClose={() => setEditingUser(null)} onSuccess={() => { setEditingUser(null); loadUsers(); }} />
      )}
    </div>
  );
}

function UserModal({ mode, user, onClose, onSuccess }: {
  mode: 'create' | 'edit';
  user?: User;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(user?.role || 'OBSERVADOR');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (mode === 'create') {
        await api.post('/users', { name, email, password, role });
      } else {
        await api.put(`/users/${user!.id}`, { name, email, role });
      }
      onSuccess();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha na operação');
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
      <div className="bg-bg-card border border-border rounded-xl p-6 w-full max-w-md animate-slide-up shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${mode === 'create' ? 'bg-accent/10 border border-accent/20 text-accent-light' : 'bg-warning/10 border border-warning/20 text-warning'}`}>
              {mode === 'create' ? <Plus className="w-4 h-4" /> : <Edit className="w-4 h-4" />}
            </div>
            <div>
              <h2 className="text-base font-bold text-text-primary">
                {mode === 'create' ? 'Registrar Usuário' : 'Editar Usuário'}
              </h2>
              <p className="text-xs text-text-secondary mt-0.5">
                {mode === 'create' ? 'Conceda acesso a novos operadores.' : `Modificar acesso de ${user?.name}`}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-card-hover transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-danger/8 border border-danger/25 text-danger text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Nome</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required
              className={inputClass} placeholder="Carlos Silva" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              className={inputClass} placeholder="email@empresa.com" />
          </div>
          {mode === 'create' && (
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Senha</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
                className={inputClass} placeholder="••••••••" />
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Nível de Acesso</label>
            <select value={role} onChange={(e) => setRole(e.target.value as 'ADM' | 'TECNICO' | 'OBSERVADOR')}
              className={inputClass}>
              <option value="ADM">Administrador (Acesso Total)</option>
              <option value="TECNICO">Técnico (Gerencia e Faz Deploys)</option>
              <option value="OBSERVADOR">Observador (Apenas Leitura)</option>
            </select>
          </div>
          <div className="flex gap-3 pt-2 border-t border-border mt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-lg border border-border text-text-primary text-sm font-semibold hover:bg-bg-card-hover transition-colors">
              Cancelar
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 py-2.5 rounded-lg bg-accent hover:bg-accent-light text-white text-sm font-semibold disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {mode === 'create' ? 'Salvar Usuário' : 'Atualizar'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
