import { startDockerEventStream } from './docker.service';
import prisma from '../config/database';

/**
 * Watches Docker container events.
 * When a container with 10kk.proxy.host + 10kk.proxy.port labels starts, a
 * GatewayRoute is automatically upserted so the dynamic proxy can forward traffic.
 * When the container stops/dies, the route is deactivated.
 */
export function startDockerWatcher(): void {
  startDockerEventStream((event) => {
    handleDockerEvent(event).catch((err) => {
      console.error('[DockerWatcher] Error handling event:', err.message);
    });
  });
  console.log('👁️  Docker events watcher started');
}

async function handleDockerEvent(event: any): Promise<void> {
  if (event.Type !== 'container') return;

  const action: string = event.Action;
  const attributes: Record<string, string> = event.Actor?.Attributes ?? {};

  const containerName: string = attributes['name'] ?? '';
  const proxyHost: string = attributes['10kk.proxy.host'] ?? '';
  const proxyPort: string = attributes['10kk.proxy.port'] ?? '';

  if (!proxyHost || !proxyPort || !containerName) return;

  const targetUrl = `http://${containerName}:${proxyPort}`;
  const routePath = `/${proxyHost}`;

  if (action === 'start') {
    await (prisma as any).gatewayRoute.upsert({
      where: { routePath },
      update: { targetUrl, isActive: true, name: proxyHost },
      create: { name: proxyHost, routePath, targetUrl, isActive: true },
    });
    console.log(`🌐 [Watcher] Route upserted: ${routePath} → ${targetUrl}`);
  } else if (['stop', 'die', 'destroy'].includes(action)) {
    await (prisma as any).gatewayRoute.updateMany({
      where: { routePath },
      data: { isActive: false },
    });
    console.log(`🔴 [Watcher] Route deactivated: ${routePath}`);
  }
}
