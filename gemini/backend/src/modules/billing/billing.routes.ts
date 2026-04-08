import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import { getAppUsage, getNodeEarnings } from '../../services/billing.service';

const router = Router();

// GET /api/v1/billing/apps/:appId/usage?from=ISO&to=ISO
router.get('/apps/:appId/usage', authenticate, authorize('ADM', 'TECNICO'), async (req: Request<{ appId: string }>, res: Response, next: NextFunction) => {
  try {
    const from = req.query.from ? new Date(req.query.from as string) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to   = req.query.to   ? new Date(req.query.to   as string) : new Date();
    const summary = await getAppUsage(req.params.appId, from, to);
    // Convert BigInts to strings for JSON serialisation
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

export default router;
