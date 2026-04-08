import http from 'http';
import prisma from '../config/database';
import { getContainerStats, listContainers } from './docker.service';
import { scaleOut } from './scaling.service';
import { Server as SocketServer } from 'socket.io';

const POLL_INTERVAL_MS = 15_000;

let monitoringInterval: NodeJS.Timeout | null = null;

export function startMonitoring(io: SocketServer): void {
  if (monitoringInterval) return;
  monitoringInterval = setInterval(() => runCycle(io).catch(console.error), POLL_INTERVAL_MS);
  console.log('🔍 Monitoring service started (interval: 15s)');
}

export function stopMonitoring(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
}

async function runCycle(io: SocketServer): Promise<void> {
  const instances = await prisma.containerInstance.findMany({
    where: { status: { in: ['RUNNING', 'UNHEALTHY'] } },
    include: { project: { include: { scalingPolicy: true } } },
  });

  if (instances.length === 0) return;

  const runningContainers = await listContainers();
  const runningNames = new Set(
    runningContainers
      .filter((c) => c.State === 'running')
      .flatMap((c) => c.Names.map((n) => n.replace(/^\//, ''))),
  );

  for (const instance of instances) {
    await processInstance(instance, runningNames, io).catch(console.error);
  }
}

async function processInstance(
  instance: any,
  runningNames: Set<string>,
  io: SocketServer,
): Promise<void> {
  const { project, containerName, id: instanceId, projectId, replicaIndex } = instance;

  // Container no longer running in Docker — mark stopped
  if (!runningNames.has(containerName)) {
    await prisma.containerInstance.update({
      where: { id: instanceId },
      data: { status: 'STOPPED' },
    });
    io.to(`project:${projectId}`).emit('container:metrics', {
      instanceId,
      containerName,
      replicaIndex,
      cpuPercent: 0,
      memPercent: 0,
      responseMs: null,
      healthy: false,
      status: 'STOPPED',
    });
    return;
  }

  const stats = await getContainerStats(containerName);

  let healthy = true;
  let responseMs: number | null = null;

  if (project.lbEnabled && project.lbAppPort) {
    const result = await performHealthCheck(
      containerName,
      project.lbAppPort,
      project.lbHealthPath || '/health',
    );
    healthy = result.healthy;
    responseMs = result.responseMs;
  }

  const newStatus: 'RUNNING' | 'UNHEALTHY' = healthy ? 'RUNNING' : 'UNHEALTHY';
  if (newStatus !== instance.status) {
    await prisma.containerInstance.update({
      where: { id: instanceId },
      data: { status: newStatus },
    });
  }

  io.to(`project:${projectId}`).emit('container:metrics', {
    instanceId,
    containerName,
    replicaIndex,
    cpuPercent: stats?.cpuPercent ?? 0,
    memPercent: stats?.memPercent ?? 0,
    responseMs,
    healthy,
    status: newStatus,
  });

  if (project.lbEnabled && project.scalingPolicy?.scaleEnabled) {
    await evaluateScaling(instance, stats, responseMs, project, io);
  }
}

async function evaluateScaling(
  instance: any,
  stats: { cpuPercent: number; memPercent: number } | null,
  responseMs: number | null,
  project: any,
  io: SocketServer,
): Promise<void> {
  // Only evaluate from the primary container to avoid duplicate triggers
  if (instance.replicaIndex !== 0) return;

  const policy = project.scalingPolicy;

  const cpuExceeded = stats !== null && stats.cpuPercent > policy.maxCpuPercent;
  const memExceeded = stats !== null && stats.memPercent > policy.maxMemPercent;
  const latencyExceeded = responseMs !== null && responseMs > policy.maxResponseMs;

  if (!cpuExceeded && !memExceeded && !latencyExceeded) return;

  const currentCount = await prisma.containerInstance.count({
    where: { projectId: project.id, status: { in: ['RUNNING', 'UNHEALTHY'] } },
  });

  if (currentCount >= policy.maxReplicas) return;

  if (policy.lastScaleAt) {
    const elapsed = Date.now() - new Date(policy.lastScaleAt).getTime();
    if (elapsed < policy.cooldownSeconds * 1000) return;
  }

  const reasons: string[] = [];
  if (cpuExceeded) reasons.push(`CPU ${stats!.cpuPercent.toFixed(1)}% > ${policy.maxCpuPercent}%`);
  if (memExceeded) reasons.push(`Mem ${stats!.memPercent.toFixed(1)}% > ${policy.maxMemPercent}%`);
  if (latencyExceeded) reasons.push(`Latência ${responseMs}ms > ${policy.maxResponseMs}ms`);

  const reason = reasons.join(', ');
  console.log(`🔼 Auto-scaling trigger for [${project.name}]: ${reason}`);

  await scaleOut(project, currentCount, io, reason);
}

async function performHealthCheck(
  containerName: string,
  port: number,
  path: string,
  timeoutMs = 5000,
): Promise<{ healthy: boolean; responseMs: number | null }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.get(
      { hostname: containerName, port, path, timeout: timeoutMs },
      (res) => {
        const responseMs = Date.now() - start;
        const healthy = res.statusCode !== undefined && res.statusCode < 400;
        resolve({ healthy, responseMs });
        res.resume();
      },
    );
    req.on('error', () => resolve({ healthy: false, responseMs: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ healthy: false, responseMs: null });
    });
  });
}
