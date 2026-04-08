import prisma from '../config/database';
import {
  createAndStartContainer,
  ensureLbNetwork,
  connectContainerToLbNetwork,
  stopAndRemoveContainer,
  updateNginxConfig,
} from './docker.service';
import { Server as SocketServer } from 'socket.io';

/** Returns names of all RUNNING/UNHEALTHY instances for a project, in replicaIndex order. */
async function getActiveContainerNames(projectId: string): Promise<string[]> {
  const instances = await prisma.containerInstance.findMany({
    where: { projectId, status: { in: ['RUNNING', 'UNHEALTHY'] } },
    orderBy: { replicaIndex: 'asc' },
  });
  return instances.map((i) => i.containerName);
}

export async function scaleOut(
  project: any,
  currentCount: number,
  io: SocketServer,
  reason: string,
): Promise<void> {
  const imageTag = project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const replicaIndex = currentCount;
  const containerName = `${imageTag}-replica-${replicaIndex}`;

  try {
    await ensureLbNetwork();

    // Start replica (no host port binding — nginx handles routing)
    const container = await createAndStartContainer({
      name: containerName,
      image: imageTag,
    });
    await connectContainerToLbNetwork(container.id);

    await prisma.containerInstance.create({
      data: {
        projectId: project.id,
        containerId: container.id,
        containerName,
        replicaIndex,
        status: 'RUNNING',
      },
    });

    await prisma.scalingPolicy.update({
      where: { projectId: project.id },
      data: { lastScaleAt: new Date() },
    });

    // Rebuild nginx upstream list including the new replica
    const upstreamNames = await getActiveContainerNames(project.id);
    await updateNginxConfig(imageTag, upstreamNames, project.lbAppPort);

    io.to(`project:${project.id}`).emit('scaling:triggered', {
      projectId: project.id,
      containerName,
      replicaIndex,
      reason,
    });

    console.log(`✅ Scaled out: ${containerName} (reason: ${reason})`);
  } catch (err) {
    console.error(`❌ Scale out failed for [${project.name}]:`, err);
  }
}

export async function scaleIn(project: any, io: SocketServer): Promise<void> {
  const imageTag = project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const replicas = await prisma.containerInstance.findMany({
    where: {
      projectId: project.id,
      status: { in: ['RUNNING', 'UNHEALTHY'] },
      replicaIndex: { gt: 0 },
    },
    orderBy: { replicaIndex: 'desc' },
  });

  if (replicas.length === 0) return;

  const toRemove = replicas[0];

  try {
    await stopAndRemoveContainer(toRemove.containerName);
    await prisma.containerInstance.update({
      where: { id: toRemove.id },
      data: { status: 'STOPPED' },
    });

    // Rebuild nginx upstream list without the removed replica
    const upstreamNames = await getActiveContainerNames(project.id);
    if (upstreamNames.length > 0) {
      await updateNginxConfig(imageTag, upstreamNames, project.lbAppPort);
    }

    io.to(`project:${project.id}`).emit('scaling:scaledin', {
      projectId: project.id,
      containerName: toRemove.containerName,
      replicaIndex: toRemove.replicaIndex,
    });

    console.log(`✅ Scaled in: ${toRemove.containerName}`);
  } catch (err) {
    console.error(`❌ Scale in failed for [${project.name}]:`, err);
  }
}
