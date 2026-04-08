import request from 'supertest';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createApp } from './app';

// Mock Redis
vi.mock('redis', () => ({
  createClient: vi.fn().mockReturnValue({
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue({}),
    quit: vi.fn().mockResolvedValue({}),
  }),
}));

// Mock Prisma
vi.mock('./config/database', () => ({
  default: {
    gatewayRoute: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    $connect: vi.fn().mockResolvedValue({}),
    $disconnect: vi.fn().mockResolvedValue({}),
  },
  prisma: {
    gatewayRoute: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

// Mock side effects that are triggered within createApp
vi.mock('./services/monitoring.service', () => ({
  startMonitoring: vi.fn(),
  stopMonitoring: vi.fn(),
}));

vi.mock('./services/docker-watcher.service', () => ({
  startDockerWatcher: vi.fn(),
}));

vi.mock('./services/agent-ws.service', () => ({
  startAgentWsServer: vi.fn().mockResolvedValue({}),
}));

describe('App Integration', () => {
  let app: any;
  let server: any;

  beforeAll(() => {
    const result = createApp();
    app = result.app;
    server = result.server;
  });

  afterAll(async () => {
    // Gracefully closing the server if it was listening (though in tests it usually isn't)
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('should return 200 OK for /health', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'ok');
  });

  it('should return 404 for unknown routes', async () => {
    const response = await request(app).get('/unknown-route');
    expect(response.status).toBe(404);
  });
});
