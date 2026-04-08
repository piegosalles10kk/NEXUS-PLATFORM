import { useState, useEffect } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import {
  Wallet, TrendingUp, TrendingDown, ArrowDownLeft, ArrowUpRight,
  Loader2, RefreshCw, AlertCircle, CheckCircle, Clock,
} from 'lucide-react';
import api from '../services/api';
import { Card, CardHeader } from '../components/ui/Card';
import { Modal, ModalCancelButton, ModalSubmitButton } from '../components/ui/Modal';

/* ── Types ─────────────────────────────────────────────────── */
interface LedgerTx {
  id: string;
  type: 'EARN' | 'SPEND' | 'DEPOSIT' | 'WITHDRAW';
  amountUsd: number;
  description?: string;
  createdAt: string;
}

interface PayoutReq {
  id: string;
  amountUsd: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAID';
  createdAt: string;
}

interface WalletData {
  balanceUsd: number;
  earnedUsd: number;
  spentUsd: number;
  transactions: LedgerTx[];
  payouts: PayoutReq[];
}

/* ── Helpers ───────────────────────────────────────────────── */
const USD = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4 }).format(n);

const txColor: Record<string, string> = {
  EARN:     'text-success',
  DEPOSIT:  'text-info',
  SPEND:    'text-danger',
  WITHDRAW: 'text-warning',
};

const txIcon: Record<string, JSX.Element> = {
  EARN:     <ArrowDownLeft className="w-3.5 h-3.5" />,
  DEPOSIT:  <ArrowDownLeft className="w-3.5 h-3.5" />,
  SPEND:    <ArrowUpRight  className="w-3.5 h-3.5" />,
  WITHDRAW: <ArrowUpRight  className="w-3.5 h-3.5" />,
};

const payoutBadge: Record<string, string> = {
  PENDING:  'badge badge-warning',
  APPROVED: 'badge badge-info',
  REJECTED: 'badge badge-danger',
  PAID:     'badge badge-success',
};

/* ── Chart data builder ────────────────────────────────────── */
function buildChartData(transactions: LedgerTx[]) {
  const byDay: Record<string, { spent: number; earned: number }> = {};
  for (const tx of transactions) {
    const day = tx.createdAt.slice(0, 10);
    byDay[day] = byDay[day] ?? { spent: 0, earned: 0 };
    if (tx.type === 'SPEND')  byDay[day].spent  += tx.amountUsd;
    if (tx.type === 'EARN')   byDay[day].earned += tx.amountUsd;
    if (tx.type === 'DEPOSIT') byDay[day].earned += tx.amountUsd;
  }
  return Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({ day, ...v }));
}

/* ── Deposit Modal ─────────────────────────────────────────── */
function DepositModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/v1/billing/wallet/deposit', { amountUsd: parseFloat(amount) });
      onDone();
      onClose();
      setAmount('');
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Erro ao depositar.');
    } finally { setLoading(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Adicionar Fundos" size="sm"
      footer={<><ModalCancelButton onClick={onClose} /><ModalSubmitButton label="Depositar" loading={loading} form="deposit-form" /></>}
    >
      <form id="deposit-form" onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-danger/10 border border-danger/20 text-danger text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />{error}
          </div>
        )}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">Valor (USD)</label>
          <input
            className="input-field"
            type="number"
            min="1"
            step="0.01"
            placeholder="10.00"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            required
          />
        </div>
      </form>
    </Modal>
  );
}

/* ── Cashout Modal ─────────────────────────────────────────── */
function CashoutModal({ open, onClose, onDone, maxUsd }: { open: boolean; onClose: () => void; onDone: () => void; maxUsd: number }) {
  const [amount, setAmount] = useState('');
  const [pixKey, setPixKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/v1/billing/wallet/cashout', { amountUsd: parseFloat(amount), pixKey: pixKey || undefined });
      onDone();
      onClose();
      setAmount('');
      setPixKey('');
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Erro ao solicitar saque.');
    } finally { setLoading(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Solicitar Saque" size="sm"
      footer={<><ModalCancelButton onClick={onClose} /><ModalSubmitButton label="Solicitar" loading={loading} form="cashout-form" /></>}
    >
      <form id="cashout-form" onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-danger/10 border border-danger/20 text-danger text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />{error}
          </div>
        )}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Valor (USD) — máx. {USD(maxUsd)}
          </label>
          <input
            className="input-field"
            type="number"
            min="1"
            max={maxUsd}
            step="0.01"
            placeholder="10.00"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">Chave PIX (opcional)</label>
          <input
            className="input-field"
            placeholder="CPF, e-mail ou telefone"
            value={pixKey}
            onChange={e => setPixKey(e.target.value)}
          />
        </div>
      </form>
    </Modal>
  );
}

/* ── Page ──────────────────────────────────────────────────── */
export default function BillingPage() {
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showCashout, setShowCashout] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/v1/billing/wallet');
      setWallet(res.data.data);
    } catch { setWallet(null); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const chartData = wallet ? buildChartData(wallet.transactions) : [];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Wallet className="w-5 h-5 text-accent-light" />
            <h1 className="text-2xl font-bold text-text-primary">Financeiro</h1>
          </div>
          <p className="text-[13px] text-text-secondary">Carteira, extrato e saques.</p>
        </div>
        <button onClick={load} className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-white/[0.04] transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Balance cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="md:col-span-1">
          <p className="text-[12px] text-text-muted mb-1">Saldo disponível</p>
          <p className="text-3xl font-bold text-text-primary">{USD(wallet?.balanceUsd ?? 0)}</p>
          <div className="flex gap-2 mt-4">
            <button
              onClick={() => setShowDeposit(true)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-accent hover:bg-accent-light text-white text-sm font-semibold transition-colors"
            >
              <ArrowDownLeft className="w-3.5 h-3.5" />
              Depositar
            </button>
            <button
              onClick={() => setShowCashout(true)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-white/[0.04] transition-colors"
            >
              <ArrowUpRight className="w-3.5 h-3.5" />
              Sacar
            </button>
          </div>
        </Card>

        <Card>
          <p className="text-[12px] text-text-muted mb-1 flex items-center gap-1">
            <TrendingUp className="w-3.5 h-3.5 text-success" />
            Total ganho (Provider)
          </p>
          <p className="text-2xl font-bold text-success">{USD(wallet?.earnedUsd ?? 0)}</p>
        </Card>

        <Card>
          <p className="text-[12px] text-text-muted mb-1 flex items-center gap-1">
            <TrendingDown className="w-3.5 h-3.5 text-danger" />
            Total gasto (Consumer)
          </p>
          <p className="text-2xl font-bold text-danger">{USD(wallet?.spentUsd ?? 0)}</p>
        </Card>
      </div>

      {/* Chart */}
      {chartData.length > 0 && (
        <Card>
          <CardHeader title="Consumo × Ganhos (30 dias)" />
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={chartData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gradSpent" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#ef4444" stopOpacity={0.18} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradEarned" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22c55e" stopOpacity={0.18} />
                  <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#52525b' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#52525b' }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}`} width={48} />
              <Tooltip
                contentStyle={{ background: '#141417', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, fontSize: 12 }}
                formatter={(v: any) => USD(v)}
              />
              <Area type="monotone" dataKey="spent"  stroke="#ef4444" strokeWidth={1.5} fill="url(#gradSpent)"  name="Gasto" />
              <Area type="monotone" dataKey="earned" stroke="#22c55e" strokeWidth={1.5} fill="url(#gradEarned)" name="Ganho" />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Ledger transactions */}
        <Card padding="none">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-[15px] font-semibold text-text-primary">Extrato</h2>
          </div>
          {(wallet?.transactions ?? []).length === 0 ? (
            <p className="text-center text-[13px] text-text-muted py-12">Nenhuma transação.</p>
          ) : (
            <div className="divide-y divide-border max-h-[360px] overflow-y-auto">
              {wallet!.transactions.map(tx => (
                <div key={tx.id} className="flex items-center gap-3 px-5 py-3">
                  <span className={`${txColor[tx.type]} shrink-0`}>{txIcon[tx.type]}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] text-text-primary truncate">{tx.description ?? tx.type}</p>
                    <p className="text-[11px] text-text-muted">{new Date(tx.createdAt).toLocaleString('pt-BR')}</p>
                  </div>
                  <span className={`text-[13px] font-semibold shrink-0 ${txColor[tx.type]}`}>
                    {['SPEND','WITHDRAW'].includes(tx.type) ? '-' : '+'}{USD(tx.amountUsd)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Payout requests */}
        <Card padding="none">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-[15px] font-semibold text-text-primary">Saques</h2>
          </div>
          {(wallet?.payouts ?? []).length === 0 ? (
            <p className="text-center text-[13px] text-text-muted py-12">Nenhum saque solicitado.</p>
          ) : (
            <div className="divide-y divide-border max-h-[360px] overflow-y-auto">
              {wallet!.payouts.map(p => (
                <div key={p.id} className="flex items-center gap-3 px-5 py-3">
                  <span className={payoutBadge[p.status]}>{p.status}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] text-text-primary">{USD(p.amountUsd)}</p>
                    <p className="text-[11px] text-text-muted">{new Date(p.createdAt).toLocaleString('pt-BR')}</p>
                  </div>
                  {p.status === 'PAID'     && <CheckCircle className="w-4 h-4 text-success shrink-0" />}
                  {p.status === 'PENDING'  && <Clock       className="w-4 h-4 text-warning shrink-0" />}
                  {p.status === 'REJECTED' && <AlertCircle className="w-4 h-4 text-danger  shrink-0" />}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <DepositModal open={showDeposit} onClose={() => setShowDeposit(false)} onDone={load} />
      <CashoutModal open={showCashout} onClose={() => setShowCashout(false)} onDone={load} maxUsd={wallet?.balanceUsd ?? 0} />
    </div>
  );
}
