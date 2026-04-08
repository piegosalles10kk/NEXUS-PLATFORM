import { Router } from 'express';
import * as deploysController from './deploys.controller';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';

const router = Router();

router.use(authenticate);

// All roles can view deploy history
router.get('/projects/:projectId/deploys', deploysController.listDeploys);
router.get('/deploys/:id', deploysController.getDeployById);

// Only ADM and TECNICO can trigger/cancel deploys
router.post('/projects/:projectId/deploys', authorize('ADM', 'TECNICO'), deploysController.triggerDeploy);
router.post('/deploys/:id/cancel', authorize('ADM', 'TECNICO'), deploysController.cancelDeploy);

export default router;
