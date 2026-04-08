import prisma from '../../config/database';
import { NotFoundError } from '../../utils/errors';

export async function listDeploys(projectId: string, page: number = 1, limit: number = 20) {
  const skip = (page - 1) * limit;

  const [deploys, total] = await Promise.all([
    prisma.deployHistory.findMany({
      where: { projectId },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        triggeredBy: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.deployHistory.count({ where: { projectId } }),
  ]);

  return { deploys, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getDeployById(id: string) {
  const deploy = await prisma.deployHistory.findUnique({
    where: { id },
    include: {
      project: { select: { id: true, name: true } },
    },
  });

  if (!deploy) throw new NotFoundError('Deploy');
  return deploy;
}

export async function createDeploy(projectId: string, triggeredById?: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new NotFoundError('Project');

  const deploy = await prisma.deployHistory.create({
    data: {
      projectId,
      status: 'RUNNING',
      ...(triggeredById && { triggeredById }),
    },
  });

  return { deploy, project };
}
