import { Router } from 'express';
import * as projectsController from './projects.controller';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';

const router = Router();

router.use(authenticate);

// All roles can view
router.get('/', projectsController.listProjects);
router.get('/stats', projectsController.getStats);
router.get('/:id', projectsController.getProjectById);

// Only ADM and TECNICO can create/update
router.post('/', authorize('ADM', 'TECNICO'), projectsController.createProject);
router.put('/:id', authorize('ADM', 'TECNICO'), projectsController.updateProject);
router.put('/:id/workflow', authorize('ADM', 'TECNICO'), projectsController.saveWorkflow);

// Only ADM can delete
router.delete('/:id', authorize('ADM'), projectsController.deleteProject);

// Container lifecycle (NODE/CLOUD projects)
router.post('/:id/stop',    authorize('ADM', 'TECNICO'), projectsController.stopProject);
router.post('/:id/restart', authorize('ADM', 'TECNICO'), projectsController.restartProject);

// File manager
router.get('/:id/files',         authenticate, projectsController.listFiles);
router.get('/:id/files/content', authenticate, projectsController.getFileContent);
router.put('/:id/files/content', authorize('ADM', 'TECNICO'), projectsController.updateFile);
router.post('/:id/files/copy', authorize('ADM', 'TECNICO'), projectsController.copyFile);
router.post('/:id/files/move', authorize('ADM', 'TECNICO'), projectsController.moveFile);
router.delete('/:id/files', authorize('ADM', 'TECNICO'), projectsController.deleteFile);

// AI & Logs
router.post('/:id/sync',       authorize('ADM', 'TECNICO'), projectsController.syncRepository);
router.post('/:id/analyze',    authorize('ADM', 'TECNICO'), projectsController.analyzeProject);
router.post('/:id/logs/start', authorize('ADM', 'TECNICO'), projectsController.startLogs);
router.post('/:id/logs/stop',  authorize('ADM', 'TECNICO'), projectsController.stopLogs);

export default router;
