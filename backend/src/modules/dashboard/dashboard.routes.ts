import { Router } from 'express';
import * as Controller from './dashboard.controller';
import { authenticate } from '../../middlewares/auth';

const router = Router();

router.use(authenticate);

router.get('/widgets', Controller.getWidgets);
router.post('/widgets', Controller.createWidget);
router.delete('/widgets/:id', Controller.deleteWidget);
router.patch('/widgets/layout', Controller.updateLayout);

export default router;
