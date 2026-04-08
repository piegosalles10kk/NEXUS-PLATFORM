import prisma from '../../config/database';
import { NotFoundError } from '../../utils/errors';
import { CreateProjectInput, UpdateProjectInput, SaveWorkflowInput } from './projects.schema';
import { sendRemoveCommand } from '../../services/agent-ws.service';
import { encrypt } from '../../services/crypto.service';

export async function listProjects(page: number = 1, limit: number = 20) {
  const skip = (page - 1) * limit;

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        deploys: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            commitHash: true,
            commitMsg: true,
            status: true,
            testsPassed: true,
            testsTotal: true,
            createdAt: true,
          },
        },
        _count: { select: { secrets: true, deploys: true } },
      },
    }),
    prisma.project.count(),
  ]);

  return { projects, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getProjectById(id: string) {
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      deploys: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          commitHash: true,
          commitMsg: true,
          commitAuthorName: true,
          commitAuthorEmail: true,
          status: true,
          testsPassed: true,
          testsTotal: true,
          createdAt: true,
          triggeredBy: { select: { id: true, name: true, email: true } },
        },
      },
      steps: { orderBy: { order: 'asc' } },
      scalingPolicy: true,
      _count: { select: { secrets: true, deploys: true } },
    },
  });

  if (!project) throw new NotFoundError('Project');
  return project;
}

export async function saveWorkflow(projectId: string, data: SaveWorkflowInput) {
  await getProjectById(projectId);
  await prisma.$transaction([
    prisma.workflowStep.deleteMany({ where: { projectId } }),
    prisma.workflowStep.createMany({
      data: data.steps.map((s) => ({
        projectId,
        order: s.order,
        name: s.name,
        type: s.type,
        command: s.command,
      })),
    }),
  ]);
  return prisma.workflowStep.findMany({
    where: { projectId },
    orderBy: { order: 'asc' },
  });
}

export async function createProject(data: CreateProjectInput) {
  return prisma.project.create({ data });
}

export async function updateProject(id: string, data: UpdateProjectInput) {
  const { envVars, ...updateData } = data;
  const existing = await getProjectById(id);

  // Migration: if the project is moving from one NODE to another, clean up the old container.
  const oldNodeId = (existing as any).nodeId as string | null;
  const newNodeId = updateData.nodeId ?? oldNodeId;
  const isNodeMigration =
    existing.environmentType === 'NODE' &&
    oldNodeId &&
    newNodeId &&
    oldNodeId !== newNodeId;

  if (isNodeMigration) {
    const imageName = existing.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    sendRemoveCommand(oldNodeId!, imageName);
  }

  const updated = await prisma.project.update({ where: { id }, data: updateData as any });

  if (envVars && envVars.length > 0) {
    for (const keyName of envVars) {
      const existingSecret = await prisma.projectSecret.findUnique({
        where: { projectId_keyName: { projectId: id, keyName } }
      });

      if (!existingSecret) {
        await prisma.projectSecret.create({
          data: {
            projectId: id,
            keyName,
            encryptedValue: encrypt(''),
          }
        });
      }
    }
  }

  return updated;
}

export async function deleteProject(id: string) {
  await getProjectById(id);
  await prisma.project.delete({ where: { id } });
}

export async function getProjectStats() {
  const [total, active, failed, paused] = await Promise.all([
    prisma.project.count(),
    prisma.project.count({ where: { status: 'ATIVO' } }),
    prisma.project.count({ where: { status: 'FALHOU' } }),
    prisma.project.count({ where: { status: 'PAUSADO' } }),
  ]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [deploysToday, successToday] = await Promise.all([
    prisma.deployHistory.count({ where: { createdAt: { gte: today } } }),
    prisma.deployHistory.count({ where: { createdAt: { gte: today }, status: 'SUCCESS' } }),
  ]);

  return {
    projects: { total, active, failed, paused },
    deploys: {
      today: deploysToday,
      successRate: deploysToday > 0 ? Math.round((successToday / deploysToday) * 100) : 100,
    },
  };
}
