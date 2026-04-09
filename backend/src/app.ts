import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import http from 'http';
import path from 'path';
import { Server as SocketServer } from 'socket.io';
import jwt from 'jsonwebtoken';

import { env } from './config/env';
import { errorHandler } from './middlewares/error-handler';

// Route imports
import authRoutes from './modules/auth/auth.routes';
import usersRoutes from './modules/users/users.routes';
import projectsRoutes from './modules/projects/projects.routes';
import secretsRoutes from './modules/secrets/secrets.routes';
import deploysRoutes from './modules/deploys/deploys.routes';
import webhookRoutes from './modules/webhook/webhook.routes';
import settingsRoutes from './modules/settings/settings.routes';
import lbRoutes from './modules/lb/lb.routes';
import gatewayRoutes from './modules/gateway/gateway.routes';
import cloudRoutes from './modules/cloud/cloud.routes';
import agentRoutes from './modules/agent/agent.routes';
import dashboardRoutes from './modules/dashboard/dashboard.routes';
import schedulerRoutes from './modules/scheduler/scheduler.routes';
import billingRoutes from './modules/billing/billing.routes';
import ingressRoutes from './modules/ingress/ingress.routes';
import clusterRoutes from './modules/cluster/cluster.routes';
import { startAgentWsServer } from './services/agent-ws.service';
import { startFailoverMonitor } from './services/failover.service';
import { trafficManager } from './modules/gateway/traffic.middleware';
import { dynamicProxy } from './modules/gateway/proxy.service';
import { startMonitoring, stopMonitoring } from './services/monitoring.service';
import { startDockerWatcher } from './services/docker-watcher.service';
import { initGatewayConf } from './services/nginx-config.service';

export function createApp() {
  const app = express();
  const server = http.createServer(app);

  // Socket.io setup
  const io = new SocketServer(server, {
    cors: {
      origin: env.FRONTEND_URL,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Socket.io auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const decoded = jwt.verify(token, env.JWT_SECRET);
      (socket as any).user = decoded;
      next();
    } catch {
      return next(new Error('Invalid token'));
    }
  });

  // Socket.io connection handler
  io.on('connection', (socket) => {
    const user = (socket as any).user;
    console.log(`🔌 Socket connected: ${user.name} (${user.role})`);

    // Join project-specific rooms
    socket.on('join:project', (projectId: string) => {
      socket.join(`project:${projectId}`);
      console.log(`   → ${user.name} joined project room: ${projectId}`);
    });

    socket.on('leave:project', (projectId: string) => {
      socket.leave(`project:${projectId}`);
    });

    socket.on('join:server', (serverId: string) => {
      socket.join(`server:${serverId}`);
    });

    socket.on('leave:server', (serverId: string) => {
      socket.leave(`server:${serverId}`);
    });

    socket.on('send_shell_command', async ({ nodeId, command, sessionId }: { nodeId: string, command: string, sessionId: string }) => {
      const { getAgentSocket } = await import('./services/agent-ws.service');
      const ws = getAgentSocket(nodeId);
      if (ws && ws.readyState === 1) { // 1 = OPEN
        ws.send(JSON.stringify({ type: 'shell', action: 'shell', command, sessionId }));
      } else {
        socket.emit('agent:shell_output', { sessionId, message: '\r\n[Erro]: O agente não está conectado no momento.\r\n' });
        socket.emit('agent:shell_exit', { sessionId, code: -1 });
      }
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Socket disconnected: ${user.name}`);
    });
  });

  // Store io instance for use in controllers
  app.set('io', io);

  // Start container monitoring loop
  startMonitoring(io);

  // Start DePIN failover monitor
  startFailoverMonitor(io);

  // Start Docker events watcher (auto-register gateway routes via labels)
  startDockerWatcher();

  // Start mTLS WebSocket server for agent connections
  startAgentWsServer(io).catch((err) =>
    console.error('Failed to start agent WS server:', err.message),
  );

  // Sync gateway routes into Nginx config on startup
  initGatewayConf().catch((err) =>
    console.error('Failed to init gateway config:', err.message),
  );

  // Global middlewares
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "connect-src": ["'self'", "wss:", "https:", "ws:"],
      },
    },
  }));
  app.use(cors({
    origin: env.FRONTEND_URL,
    credentials: true,
  }));
  app.use(morgan('dev'));
  
  // Traffic Management (Rate Limit, Throttling, Circuit Breaker)
  app.use(trafficManager());

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ACME HTTP-01 challenge endpoint (must be before auth middleware)
  app.get('/.well-known/acme-challenge/:token', async (req, res) => {
    const { getChallenge } = await import('./services/acme.service');
    const keyAuth = await getChallenge(req.params.token);
    if (!keyAuth) { res.status(404).send('Not found'); return; }
    res.type('text/plain').send(keyAuth);
  });

  // Serve agent install script and binaries for remote VM provisioning
  const publicDir = path.join(__dirname, '..', 'public');
  app.use('/downloads', express.static(path.join(publicDir, 'downloads')));
  app.get('/install.sh', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.sendFile(path.join(publicDir, 'install.sh'));
  });
  app.get('/install.ps1', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.sendFile(path.join(publicDir, 'install.ps1'));
  });

  // API routes
  app.use('/api/auth', authRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/projects', projectsRoutes);
  app.use('/api', secretsRoutes);  // /api/projects/:id/secrets & /api/secrets/:id
  app.use('/api', deploysRoutes);  // /api/projects/:id/deploys & /api/deploys/:id
  app.use('/api/settings', settingsRoutes);
  app.use('/api/projects', lbRoutes);
  app.use('/api/gateway', gatewayRoutes);
  app.use('/api/cloud', cloudRoutes);
  app.use('/api/v1/agent', agentRoutes);
  app.use('/api/v1/scheduler', schedulerRoutes);
  app.use('/api/v1/billing', billingRoutes);
  app.use('/api/v1/clusters', clusterRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/webhook', webhookRoutes);

  // ── DePIN Ingress — HTTP → WS tunnel → node echo server ─────────────────
  // Registered BEFORE dynamicProxy so /depin/* is not caught by nginx proxy logic.
  // Public (no auth) — the app slug is the entry credential in the MVP.
  app.use('/depin', ingressRoutes);

  // Tunnel proxy middleware — handles requests forwarded by nginx for tunnelled
  // gateway routes (those whose nginx location block proxies to this server).
  // Must be registered after all API routes so it only catches non-API paths.
  app.use(dynamicProxy);

  // Error handler (must be last)
  app.use(errorHandler);

  return { app, server, io };
}
