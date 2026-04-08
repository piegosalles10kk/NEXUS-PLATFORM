import { Router } from 'express';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import * as lbController from './lb.controller';

const router = Router({ mergeParams: true });

router.use(authenticate);

// All roles can view instances and policy
router.get('/:id/instances', lbController.listInstances);
router.get('/:id/scaling', lbController.getScalingPolicy);

// ADM + TECNICO can manage
router.put('/:id/scaling', authorize('ADM', 'TECNICO'), lbController.saveScalingPolicy);
router.delete('/:id/instances/:instanceId', authorize('ADM', 'TECNICO'), lbController.removeInstance);
router.post('/:id/scale-in', authorize('ADM', 'TECNICO'), lbController.triggerScaleIn);

export default router;
