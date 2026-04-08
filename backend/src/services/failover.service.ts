/**
 * failover.service.ts
 *
 * Monitors heartbeats from nodes. When a node stops responding:
 *  1. Marks it OFFLINE in the DB
 *  2. Finds all DePIN apps with RUNNING assignments on that node
 *  3. For each app, selects a replacement node and dispatches the workload
 *  4. Updates the NodeAssignment records accordingly
 *  5. Emits a Socket.io event so the frontend shows the failover
 *
 * The failover monitor runs on a configurable interval (default 15s).
 * A node is considered dead if its lastPing is older than DEAD_THRESHOLD_MS.
 */
import { Server as SocketServer } from 'socket.io';
import prisma from '../config/database';
import { selectNodes } from './scheduler.service';
import { sendWorkloadToNodes } from './workload-dispatch.service';

const DEAD_THRESHOLD_MS = 30_000;  // 30 seconds without ping = node is dead
const CHECK_INTERVAL_MS = 15_000;  // how often we check

let monitorTimer: NodeJS.Timeout | null = null;

export function startFailoverMonitor(io: SocketServer): void {
  if (monitorTimer) return;

  monitorTimer = setInterval(() => runFailoverCheck(io), CHECK_INTERVAL_MS);
  console.log('🔁 Failover monitor started');
}

export function stopFailoverMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

async function runFailoverCheck(io: SocketServer): Promise<void> {
  const deadThreshold = new Date(Date.now() - DEAD_THRESHOLD_MS);

  // Find nodes that were ONLINE but haven't pinged recently
  const deadNodes = await prisma.node.findMany({
    where: {
      status: 'ONLINE',
      lastPing: { lt: deadThreshold },
    },
  });

  for (const node of deadNodes) {
    console.warn(`[failover] Node ${node.name} (${node.id}) appears dead — last ping: ${node.lastPing.toISOString()}`);

    // 1. Mark as OFFLINE
    await prisma.node.update({
      where: { id: node.id },
      data:  { status: 'OFFLINE' },
    }).catch(console.error);

    io.emit('node:offline', { nodeId: node.id, name: node.name });

    // 2. Find affected DePIN app assignments
    const affected = await prisma.nodeAssignment.findMany({
      where:   { nodeId: node.id, status: 'RUNNING' },
      include: {
        app: {
          include: {
            assignments: {
              where:   { status: 'RUNNING' },
              include: { node: true },
            },
          },
        },
      },
    });

    for (const assignment of affected) {
      const app = assignment.app;

      // Mark this assignment as OFFLINE
      await prisma.nodeAssignment.update({
        where: { id: assignment.id },
        data:  { status: 'OFFLINE' },
      }).catch(console.error);

      // Check if app is still healthy enough (any RUNNING assignments left)
      const runningCount = app.assignments.filter(
        (a: { nodeId: string; status: string }) => a.nodeId !== node.id && a.status === 'RUNNING',
      ).length;

      // Update app status
      const appStatus = runningCount > 0 ? 'DEGRADED' : 'OFFLINE';
      await prisma.dePINApp.update({
        where: { id: app.id },
        data:  { status: appStatus },
      }).catch(console.error);

      io.emit('app:degraded', { appId: app.id, slug: app.slug, failedNodeId: node.id, runningCount });

      // 3. Attempt to find a replacement node
      const existingNodeIds = app.assignments.map((a: { nodeId: string }) => a.nodeId);
      const candidates = await selectNodes({ count: 5, region: app.region ?? undefined });
      const replacement = candidates.find((c) => !existingNodeIds.includes(c.id));

      if (!replacement) {
        console.warn(`[failover] No replacement available for app ${app.slug}`);
        continue;
      }

      // 4. Create new assignment
      const newAssignment = await prisma.nodeAssignment.create({
        data: {
          appId:  app.id,
          nodeId: replacement.id,
          role:   app.executionMode === 'MICROVM' ? 'FOLLOWER' : 'WASM_WORKER',
          status: 'RUNNING',
        },
      }).catch((err: unknown) => { console.error(err); return null; });

      if (!newAssignment) continue;

      // Update app status back to RUNNING if we have enough replicas
      await prisma.dePINApp.update({
        where: { id: app.id },
        data:  { status: 'RUNNING' },
      }).catch(console.error);

      // 5. Dispatch workload to replacement node
      await sendWorkloadToNodes(app, [replacement]).catch(console.error);

      console.log(`[failover] App ${app.slug} — replaced node ${node.id} with ${replacement.id}`);
      io.emit('app:recovered', {
        appId:          app.id,
        slug:           app.slug,
        failedNodeId:   node.id,
        replacementNodeId: replacement.id,
        replacementName:   replacement.name,
      });
    }
  }
}
