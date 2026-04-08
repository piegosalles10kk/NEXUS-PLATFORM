import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { getAppUsage, getNodeEarnings } from '../../services/billing.service';
import { deposit, requestCashout, getWallet } from '../../services/wallet.service';

const router = Router();

// ── Usage / Earnings (existing) ───────────────────────────────────────────────

// GET /api/v1/billing/apps/:appId/usage?from=ISO&to=ISO
router.get('/apps/:appId/usage', authenticate, authorize('ADM', 'TECNICO'), async (req: Request<{ appId: string }>, res: Response, next: NextFunction) => {
  try {
    const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to   = req.query.to   ? new Date(req.query.to   as string) : new Date();
    const summary = await getAppUsage(req.params.appId, from, to);
    res.json({ status: 'success', data: {
      ...summary,
      cpuMs:      summary.cpuMs.toString(),
      ramMbS:     summary.ramMbS.toString(),
      netRxBytes: summary.netRxBytes.toString(),
      netTxBytes: summary.netTxBytes.toString(),
    }});
  } catch (err) { next(err); }
});

// GET /api/v1/billing/nodes/:nodeId/earnings?from=ISO&to=ISO
router.get('/nodes/:nodeId/earnings', authenticate, authorize('ADM'), async (req: Request<{ nodeId: string }>, res: Response, next: NextFunction) => {
  try {
    const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to   = req.query.to   ? new Date(req.query.to   as string) : new Date();
    const earnings = await getNodeEarnings(req.params.nodeId, from, to);
    res.json({ status: 'success', data: {
      ...earnings,
      cpuMs:      earnings.cpuMs.toString(),
      ramMbS:     earnings.ramMbS.toString(),
      netTxBytes: earnings.netTxBytes.toString(),
    }});
  } catch (err) { next(err); }
});

// ── Wallet ────────────────────────────────────────────────────────────────────

// GET /api/v1/billing/wallet  — get current user's wallet + ledger
router.get('/wallet', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const wallet = await getWallet(userId);
    res.json({ status: 'success', data: wallet });
  } catch (err) { next(err); }
});

// POST /api/v1/billing/wallet/deposit  { amountUsd: number }
router.post('/wallet/deposit', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { amountUsd } = req.body;
    if (!amountUsd || amountUsd <= 0) {
      res.status(400).json({ status: 'error', message: 'Valor inválido.' });
      return;
    }
    await deposit(userId, Number(amountUsd));
    const wallet = await getWallet(userId);
    res.json({ status: 'success', data: wallet });
  } catch (err) { next(err); }
});

// POST /api/v1/billing/wallet/cashout  { amountUsd: number, pixKey?: string }
router.post('/wallet/cashout', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { amountUsd, pixKey } = req.body;
    if (!amountUsd || amountUsd <= 0) {
      res.status(400).json({ status: 'error', message: 'Valor inválido.' });
      return;
    }
    const payout = await requestCashout(userId, Number(amountUsd), pixKey);
    res.json({ status: 'success', data: payout });
  } catch (err: any) {
    if (err.message === 'Saldo insuficiente.') {
      res.status(400).json({ status: 'error', message: err.message });
      return;
    }
    next(err);
  }
});

export default router;
