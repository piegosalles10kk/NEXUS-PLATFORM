import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '../config/database';

const execAsync = promisify(exec);

// Shared volume path (mounted in both backend and frontend containers)
const GATEWAY_CONF_PATH = process.env.GATEWAY_CONF_PATH || '/shared/gateway.conf';

// Reserved paths that must never be overridden by gateway routes
const RESERVED_PATHS = ['/api', '/webhook', '/install.sh', '/downloads', '/health', '/ws'];

export function isReservedPath(routePath: string): boolean {
  return RESERVED_PATHS.some((reserved) => routePath.startsWith(reserved));
}

/**
 * Generates the Nginx gateway.conf content from all active routes in the DB.
 */
async function generateGatewayConf(): Promise<string> {
  const routes = await prisma.gatewayRoute.findMany({
    where: { isActive: true },
    orderBy: { routePath: 'asc' },
  });

  if (routes.length === 0) {
    // Empty config — Nginx still needs a valid (but empty) include file
    return '# No active gateway routes\n';
  }

  const blocks = routes.map((route) => {
    const safePath = route.routePath.replace(/\/+$/, ''); // strip trailing slashes

    // Tunnelled routes: nginx forwards to the Express backend, which then
    // dispatches the request through the agent WebSocket tunnel.
    if ((route as any).isTunnelled) {
      return `
# Route: ${route.name} (Tunnel via Agent)
location ${safePath}/ {
    proxy_pass http://10kk-backend:4500;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 10s;
    proxy_read_timeout 35s;
}

location = ${safePath} {
    return 301 ${safePath}/;
}
`;
    }

    // Direct routes: nginx proxies straight to the target service.
    const target = route.targetUrl.replace(/\/+$/, '');
    return `
# Route: ${route.name}
location ${safePath}/ {
    proxy_pass ${target}/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
    proxy_connect_timeout 60s;
    proxy_read_timeout 60s;
}

location = ${safePath} {
    return 301 ${safePath}/;
}
`;
  });

  return `# ── Nexus Gateway — auto-generated, do not edit manually ──\n${blocks.join('\n')}`;
}

/**
 * Writes the gateway.conf and reloads Nginx inside the frontend container.
 */
export async function reloadNginxGateway(): Promise<void> {
  try {
    // Ensure the shared directory exists
    const dir = path.dirname(GATEWAY_CONF_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const conf = await generateGatewayConf();
    fs.writeFileSync(GATEWAY_CONF_PATH, conf, 'utf8');
    console.log(`[Gateway] Written ${GATEWAY_CONF_PATH} (${conf.length} bytes)`);

    // Reload Nginx inside the frontend container via Docker socket
    await execAsync('docker exec 10kk-frontend nginx -s reload');
    console.log('[Gateway] Nginx reloaded successfully.');
  } catch (err: any) {
    // Non-fatal: log but don't crash the request
    console.error('[Gateway] Failed to reload Nginx:', err.message);
  }
}

/**
 * Called once on server startup to sync the gateway.conf with current DB state.
 */
export async function initGatewayConf(): Promise<void> {
  console.log('[Gateway] Initializing gateway config...');
  await reloadNginxGateway();
}
