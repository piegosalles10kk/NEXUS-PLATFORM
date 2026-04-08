import { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import { prisma } from '../../config/database';
import { sendProxyRequest } from '../../services/agent-ws.service';

/**
 * Dinamic Proxy Middleware
 * Intercepta requisições e as encaminha para o destino correto com base no path.
 * Rotas marcadas como isTunnelled são encaminhadas através do túnel WebSocket do agente.
 */
export const dynamicProxy = async (req: Request, res: Response, next: NextFunction) => {
  // Ignora rotas da própria API e Webhooks
  if (req.path.startsWith('/api') || req.path.startsWith('/webhook') || req.path === '/health') {
    return next();
  }

  try {
    // Busca todas as rotas ativas
    const routes = await prisma.gatewayRoute.findMany({
      where: { isActive: true },
    });

    // Encontra a rota que mais se aproxima do path atual
    const matchedRoute = routes.find((r: any) => req.path.startsWith(r.routePath));

    if (!matchedRoute) {
      return next(); // Segue para o próximo middleware ou 404
    }

    // ── Tunnel mode: forward via agent WebSocket ──────────────────────────────
    if ((matchedRoute as any).isTunnelled) {
      return handleTunnelRequest(req, res, matchedRoute as any);
    }

    // ── Direct mode: standard HTTP proxy ─────────────────────────────────────
    const proxyOptions: Options = {
      target: matchedRoute.targetUrl,
      changeOrigin: true,
      pathRewrite: {
        [`^${matchedRoute.routePath}`]: '', // Remove o prefixo da rota ao encaminhar
      },
      on: {
        error: (err: Error, req: any, res: any) => {
          console.error(`Proxy Error (${matchedRoute.name}):`, err);
          (res as Response).status(502).send('Bad Gateway - O serviço de destino não está respondendo.');
        },
      },
    };

    // Cria e executa o proxy para esta requisição
    const proxy = createProxyMiddleware(proxyOptions);
    return proxy(req, res, next);

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
