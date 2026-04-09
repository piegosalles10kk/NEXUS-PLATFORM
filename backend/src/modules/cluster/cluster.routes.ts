import { Router } from 'express';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import * as ctrl from './cluster.controller';

const router = Router();

router.post(  '/create',              authenticate, authorize('ADM', 'TECNICO'), ctrl.createCluster);
router.get(   '/',                    authenticate, authorize('ADM', 'TECNICO'), ctrl.listClusters);
router.get(   '/:id/telemetry',       authenticate, authorize('ADM', 'TECNICO'), ctrl.clusterTelemetry);
router.delete('/:id',                 authenticate, authorize('ADM'),             ctrl.dissolveCluster);

export default router;
