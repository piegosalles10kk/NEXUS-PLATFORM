import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../config/database';
import { sendProxyRequest } from '../../services/agent-ws.service';

/**
 * Dynamic Proxy Middleware — TUNNEL-ONLY.
 *
 * Direct (non-tunnel) gateway routes are handled entirely by Nginx, which
 * proxy_passes straight to the target service. Those requests NEVER reach
 * Express, so we must NOT proxy them here (that would cause double-proxying).
 *
 * Only tunnelled routes come through Express: Nginx forwards them to the
 * backend (/api/... is excluded, so Nginx sends the tunnelled path here),
 * and we dispatch via the agent WebSocket tunnel.
 */
export const dynamicProxy = async (req: Request, res: Response, next: NextFunction) => {
  // Skip all system paths — these are handled by other Express routes
  if (
    req.path.startsWith('/api') ||
    req.path.startsWith('/webhook') ||
    req.path.startsWith('/depin') ||
    req.path === '/health'
  ) {
    return next();
  }

  try {
    // Only look for tunnelled routes — direct routes go through Nginx, not Express
    const routes = await prisma.gatewayRoute.findMany({
      where: { isActive: true, isTunnelled: true },
    });

    const matchedRoute = routes.find((r: any) => req.path.startsWith(r.routePath));

    if (!matchedRoute) {
      return next();
    }

    return handleTunnelRequest(req, res, matchedRoute as any);
  } catch (error) {
    console.error('Dynamic Proxy Error:', error);
    next(error);
  }
};

// ── Tunnel handler ────────────────────────────────────────────────────────────

async function handleTunnelRequest(
  req: Request,
  res: Response,
  route: { routePath: string; targetUrl: string; tunnelNodeId: string | null; name: string },
): Promise<void> {
  if (!route.tunnelNodeId) {
    res.status(502).json({ error: 'Tunnel route has no agent node configured.' });
    return;
  }

  // Strip the route prefix to get the path the agent should request locally.
  const downstreamPath = req.path.slice(route.routePath.length) || '/';
  const queryString    = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const fullPath       = downstreamPath + queryString;

  // Rebuild a safe subset of request headers to forward.
  const forwardHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      typeof value === 'string' &&
      !['host', 'connection', 'transfer-encoding', 'te', 'upgrade'].includes(key.toLowerCase())
    ) {
      forwardHeaders[key] = value;
    }
  }
  // Override Host to match the agent-local service.
  const targetHost = new URL(route.targetUrl).host;
  forwardHeaders['host'] = targetHost;
  forwardHeaders['x-forwarded-for']   = req.ip ?? '';
  forwardHeaders['x-forwarded-proto'] = req.protocol;
  forwardHeaders['x-forwarded-host']  = req.hostname;

  // Serialize request body.
  let bodyB64 = '';
  if (req.body !== undefined && req.body !== null) {
    const bodyStr =
      typeof req.body === 'object'
        ? JSON.stringify(req.body)
        : String(req.body);
    bodyB64 = Buffer.from(bodyStr).toString('base64');
  }

  try {
    const proxyResp = await sendProxyRequest(route.tunnelNodeId, {
      method:    req.method,
      path:      fullPath || '/',
      targetUrl: route.targetUrl,
      headers:   forwardHeaders,
      body:      bodyB64,
    });

    if (proxyResp.error) {
      console.error(`[tunnel] agent error for route ${route.name}: ${proxyResp.error}`);
      res.status(502).json({ error: `Agent error: ${proxyResp.error}` });
      return;
    }

    // Forward response headers (skip hop-by-hop headers).
    const HOP_BY_HOP = new Set([
      'connection', 'keep-alive', 'transfer-encoding', 'te',
      'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
    ]);
    for (const [key, value] of Object.entries(proxyResp.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    const bodyBuf = Buffer.from(proxyResp.body ?? '', 'base64');
    res.status(proxyResp.statusCode).end(bodyBuf);
  } catch (err: any) {
    console.error(`[tunnel] failed for route ${route.name}:`, err.message);
    res.status(502).json({ error: err.message ?? 'Tunnel proxy failed' });
  }
}
