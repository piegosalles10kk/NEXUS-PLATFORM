import { Router } from 'express';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import * as cloudController from './cloud.controller';

const router = Router();

// Flat server list — ADM and TECNICO (used in project settings to pick a server)
router.get('/servers', authenticate, authorize('ADM', 'TECNICO'), cloudController.listAllServers);

router.use(authenticate, authorize('ADM'));

// Providers
router.get('/providers', cloudController.listProviders);
router.post('/providers', cloudController.createProvider);
router.delete('/providers/:id', cloudController.deleteProvider);

// Servers per provider
router.get('/providers/:providerId/servers', cloudController.listServers);
router.post('/providers/:providerId/servers', cloudController.provisionNewServer);
router.get('/providers/:providerId/servers/:serverId', cloudController.getServerStatus);
router.post('/providers/:providerId/servers/:serverId/restart', cloudController.restartServer);
router.delete('/providers/:providerId/servers/:serverId', cloudController.deleteServer);

// Unified Server Details (Cloud or Manual Node)
router.get('/servers/:id/details', cloudController.getServerDetails);

export default router;
