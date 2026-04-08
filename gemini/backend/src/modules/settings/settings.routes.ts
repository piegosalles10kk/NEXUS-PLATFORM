import { Router } from 'express';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import * as settingsController from './settings.controller';

const router = Router();

router.use(authenticate, authorize('ADM'));

router.get('/', settingsController.listSettings);
router.put('/:key', settingsController.updateSetting);
router.delete('/:key', settingsController.resetSetting);

router.get('/docker-proxy', settingsController.listDockerPermissions);
router.put('/docker-proxy/:key', settingsController.updateDockerPermission);

export default router;
