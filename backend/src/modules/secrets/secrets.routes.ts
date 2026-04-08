import { Router } from 'express';
import * as secretsController from './secrets.controller';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';

const router = Router();

router.use(authenticate);

// Only ADM and TECNICO can manage secrets
router.get('/projects/:projectId/secrets', authorize('ADM', 'TECNICO'), secretsController.listSecrets);
router.post('/projects/:projectId/secrets', authorize('ADM', 'TECNICO'), secretsController.createSecret);
router.put('/secrets/:secretId', authorize('ADM', 'TECNICO'), secretsController.updateSecret);
router.get('/secrets/:secretId/reveal', authorize('ADM', 'TECNICO'), secretsController.revealSecret);
router.delete('/secrets/:secretId', authorize('ADM', 'TECNICO'), secretsController.deleteSecret);

export default router;
