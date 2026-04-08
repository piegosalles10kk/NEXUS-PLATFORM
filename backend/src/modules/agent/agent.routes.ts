import { Router } from 'express';
import * as agentController from './agent.controller';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';

const router = Router();

// ── Public enrollment endpoint (auth via enrollment JWT, not user session) ────
// Called by install.sh / install.ps1 during provisioning
router.post('/enroll', agentController.enrollAgent);

// ── Protected node management (ADM only) ─────────────────────────────────────
router.get(   '/nodes',             authenticate, authorize('ADM'), agentController.listNodes);
router.post(  '/nodes',             authenticate, authorize('ADM'), agentController.createNode);
router.delete('/nodes/:id',         authenticate, authorize('ADM'), agentController.deleteNode);
router.post(  '/nodes/:id/command', authenticate, authorize('ADM'), agentController.sendCommand);
router.get(   '/nodes/:id/telemetry', authenticate, authorize('ADM'), agentController.getNodeTelemetry);
router.get(   '/nodes/:id/scan-ports', authenticate, authorize('ADM', 'TECNICO'), agentController.scanNodePorts);
router.post(  '/nodes/:id/terminate',  authenticate, authorize('ADM'), agentController.terminateNodeAgent);

// ── Node Policy (Hardware Leash) ──────────────────────────────────────────────
router.put('/nodes/:id/policy', authenticate, authorize('ADM'), agentController.upsertNodePolicy);
router.get('/nodes/:id/policy', authenticate, authorize('ADM'), agentController.getNodePolicy);

// ── File Manager (Global FTP) ───────────────────────────────────────────────────
router.get(   '/nodes/:id/files',       authenticate, authorize('ADM', 'TECNICO'), agentController.listNodeFiles);
router.get(   '/nodes/:id/files/read',  authenticate, authorize('ADM', 'TECNICO'), agentController.readNodeFile);
router.post(  '/nodes/:id/files/write', authenticate, authorize('ADM', 'TECNICO'), agentController.writeNodeFile);
router.delete('/nodes/:id/files',       authenticate, authorize('ADM', 'TECNICO'), agentController.deleteNodeFile);
router.post(  '/nodes/:id/files/copy',  authenticate, authorize('ADM', 'TECNICO'), agentController.copyNodeFile);
router.post(  '/nodes/:id/files/move',  authenticate, authorize('ADM', 'TECNICO'), agentController.moveNodeFile);

export default router;
