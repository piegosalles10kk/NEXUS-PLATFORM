import { Request, Response, NextFunction } from 'express';
import * as deploysService from './deploys.service';
import { runPipeline, cancelPipeline } from '../../services/pipeline.service';

export async function listDeploys(req: Request<{ projectId: string }>, res: Response, next: NextFunction) {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const result = await deploysService.listDeploys(req.params.projectId, page, limit);
    res.json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
}

export async function getDeployById(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const deploy = await deploysService.getDeployById(req.params.id);
    res.json({ status: 'success', data: { deploy } });
  } catch (error) {
    next(error);
  }
}

export async function cancelDeploy(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const deploy = await deploysService.getDeployById(req.params.id);
    if (deploy.status !== 'RUNNING') {
      res.status(400).json({ status: 'error', message: 'Deploy não está em execução' });
      return;
    }
    cancelPipeline(req.params.id);
    res.json({ status: 'success', message: 'Cancelamento solicitado' });
  } catch (error) {
    next(error);
  }
}

export async function triggerDeploy(req: Request<{ projectId: string }>, res: Response, next: NextFunction) {
  try {
    const { deploy, project } = await deploysService.createDeploy(req.params.projectId, req.user?.id);

    // Get Socket.io instance from app
    const io = req.app.get('io');

    // Run pipeline asynchronously (don't await - it runs in the background)
    runPipeline({
      projectId: project.id,
      deployId: deploy.id,
      repoUrl: project.repoUrl,
      branch: project.branchTarget,
      projectName: project.name,
      environmentType: project.environmentType,
      nodeId: (project as any).nodeId ?? undefined,
      clean: req.body.clean === true,
      io,
    }).catch((err) => {
      console.error(`Pipeline error for deploy ${deploy.id}:`, err);
    });

    res.status(201).json({
      status: 'success',
      message: 'Deploy triggered',
      data: { deploy },
    });
  } catch (error) {
    next(error);
  }
}
