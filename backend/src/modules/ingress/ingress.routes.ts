/**
 * ingress.routes.ts
 *
 * DePIN Ingress routes — forwards HTTP traffic into the distributed node cluster.
 *
 * Routes:
 *   GET  /depin/:slug/_info       → cluster health info (no proxy, no auth needed)
 *   *    /depin/:slug/*           → proxy to a healthy WASM/VM node (round-robin)
 *
 * The /* wildcard captures everything after the slug so clients can call any
 * sub-path on their deployed app, e.g.:
 *   curl http://localhost:4500/depin/chaos-worker-final/api/orders
 *   curl http://localhost:4500/depin/my-api/v1/users/42
 */
import { Router } from 'express';
import { handleDePINIngress, getDePINClusterInfo } from '../../services/depin-ingress.service';
import { classifyRuntime } from '../../services/classifier.service';
import { getDemandRatio } from '../../services/scheduler.service';

const router = Router({ mergeParams: true });

// ── Classify + surge pricing (public — used by the deploy UI) ────────────────
router.post('/classify', async (req, res, next) => {
  try {
    const { codeHint = 'generic API', region } = req.body;
    const result = await classifyRuntime(codeHint, region);
    res.json({ status: 'success', data: result });
  } catch (err) { next(err); }
});

// ── Demand ratio (for the UI to show live surge indicator) ───────────────────
router.get('/demand', async (req, res, next) => {
  try {
    const region = req.query.region as string | undefined;
    const ratio = await getDemandRatio(region);
    res.json({ status: 'success', data: { region: region ?? 'global', demandRatio: ratio } });
  } catch (err) { next(err); }
});

// ── Domain management ────────────────────────────────────────────────────────
import { authenticate } from '../../middlewares/auth';
import { assignDomain, verifyDns } from '../../services/acme.service';
import prisma from '../../config/database';

// POST /depin/apps/:id/domain  { domain: "myapp.com" }
router.post('/apps/:id/domain', authenticate, async (req, res, next) => {
  try {
    const { domain } = req.body;
    if (!domain) { res.status(400).json({ status: 'error', message: 'domain required' }); return; }
    const result = await assignDomain(req.params.id as string, domain);
    res.json({ status: 'success', data: result });
  } catch (err) { next(err); }
});

// GET /depin/apps/:id/domain/verify
router.get('/apps/:id/domain/verify', authenticate, async (req, res, next) => {
  try {
    const app = await prisma.dePINApp.findUnique({ where: { id: req.params.id as string }, select: { customDomain: true } });
    if (!app?.customDomain) { res.status(400).json({ status: 'error', message: 'No custom domain set' }); return; }
    const dnsOk = await verifyDns(app.customDomain);
    res.json({ status: 'success', data: { dnsOk, domain: app.customDomain } });
  } catch (err) { next(err); }
});

// ── Cluster info (public — useful for monitoring dashboards) ─────────────────
router.get('/:slug/_info', (req, res) => getDePINClusterInfo(req, res));

// ── Ingress proxy — all methods, any sub-path ────────────────────────────────
// Express wildcard: * matches /api/users, /health, /, etc.
router.all('/:slug/*', (req, res) => handleDePINIngress(req, res));

// Bare slug with no trailing path (e.g. /depin/my-app)
router.all('/:slug', (req, res) => {
  // Normalise: treat /depin/my-app as /depin/my-app/
  (req.params as any)[0] = '/';
  handleDePINIngress(req, res);
});

export default router;
