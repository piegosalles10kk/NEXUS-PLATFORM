import { Router } from 'express';
import { GatewayController } from './gateway.controller';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';

const router = Router();

// Todas as rotas administrativas exigem pelo menos nível TÉCNICO
router.get('/', authenticate, authorize('ADM', 'TECNICO'), GatewayController.getRoutes);
router.post('/', authenticate, authorize('ADM', 'TECNICO'), GatewayController.createRoute);
router.put('/:id', authenticate, authorize('ADM', 'TECNICO'), GatewayController.updateRoute);
router.delete('/:id', authenticate, authorize('ADM'), GatewayController.deleteRoute);

// Stats for dashboard
router.get('/stats', authenticate, authorize('ADM', 'TECNICO'), GatewayController.getStats);

// Service discovery
router.get('/discover', authenticate, authorize('ADM', 'TECNICO'), GatewayController.discoverPorts);

export default router;
