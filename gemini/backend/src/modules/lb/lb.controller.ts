import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../config/database';
import { stopAndRemoveContainer } from '../../services/docker.service';
import { scaleIn } from '../../services/scaling.service';
import { NotFoundError } from '../../utils/errors';

const scalingPolicySchema = z.object({
  maxCpuPercent: z.number().min(1).max(100).default(80),
  maxMemPercent: z.number().min(1).max(100).default(80),
  maxResponseMs: z.number().int().min(100).default(2000),
  minReplicas: z.number().int().min(1).default(1),
  maxReplicas: z.number().int().min(1).max(10).default(3),
  cooldownSeconds: z.number().int().min(10).default(120),
  scaleEnabled: z.boolean().default(true),
});

export async function listInstances(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const instances = await prisma.containerInstance.findMany({
      where: { projectId: req.params.id },
      orderBy: [{ replicaIndex: 'asc' }, { createdAt: 'desc' }],
    });
    res.json({ status: 'success', data: { instances } });
  } catch (error) {
    next(error);
  }
}

export async function getScalingPolicy(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const policy = await prisma.scalingPolicy.findUnique({
      where: { projectId: req.params.id },
    });
    res.json({ status: 'success', data: { policy } });
  } catch (error) {
    next(error);
  }
}

export async function saveScalingPolicy(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = scalingPolicySchema.parse(req.body);
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) throw new NotFoundError('Project');

    const policy = await prisma.scalingPolicy.upsert({
      where: { projectId: req.params.id },
      update: data,
      create: { ...data, projectId: req.params.id },
    });
    res.json({ status: 'success', data: { policy } });
  } catch (error) {
    next(error);
  }
}

export async function removeInstance(
  req: Request<{ id: string; instanceId: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const instance = await prisma.containerInstance.findUnique({
      where: { id: req.params.instanceId },
    });
    if (!instance || instance.projectId !== req.params.id) {
      throw new NotFoundError('ContainerInstance');
    }
    if (instance.replicaIndex === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Não é possível remover o container primário. Use o deploy para substituí-lo.',
      });
    }

    try {
      await stopAndRemoveContainer(instance.containerName);
    } catch { /* already stopped */ }

    await prisma.containerInstance.update({
      where: { id: instance.id },
      data: { status: 'STOPPED' },
    });

    res.json({ status: 'success', message: 'Instância removida.' });
  } catch (error) {
    next(error);
  }
}

export async function triggerScaleIn(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) throw new NotFoundError('Project');

    const io = req.app.get('io');
    await scaleIn(project, io);

    res.json({ status: 'success', message: 'Scale-in iniciado.' });
  } catch (error) {
    next(error);
  }
}
