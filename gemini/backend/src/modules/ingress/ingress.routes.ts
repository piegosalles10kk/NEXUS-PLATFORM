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

const router = Router({ mergeParams: true });

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
