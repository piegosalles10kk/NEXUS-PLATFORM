import { Router } from 'express';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import * as ctrl from './scheduler.controller';

const router = Router();

// Node inspection
router.get('/nodes',              authenticate, authorize('ADM', 'TECNICO'), ctrl.getAvailableNodes);

// App lifecycle
router.post(  '/deploy',          authenticate, authorize('ADM', 'TECNICO'), ctrl.deployApp);
router.get(   '/apps',            authenticate, authorize('ADM', 'TECNICO'), ctrl.listApps);
router.get(   '/apps/:id',        authenticate, authorize('ADM', 'TECNICO'), ctrl.getApp);
router.patch( '/apps/:id',        authenticate, authorize('ADM', 'TECNICO'), ctrl.resizeApp);
router.delete('/apps/:id',        authenticate, authorize('ADM', 'TECNICO'), ctrl.removeApp);
router.post(  '/apps/:id/reassign', authenticate, authorize('ADM'),          ctrl.reassignNode);

export default router;
