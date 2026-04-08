import { Request, Response, NextFunction } from 'express';
import { getRedisClient } from '../../config/redis';

// Configuração do Redis para Rate Limiting
let redisClient: any = null;
(async () => {
  try {
    redisClient = await getRedisClient();
  } catch (error) {
    console.warn('⚠️  Redis não disponível para Gateway, usando memória local');
  }
})();

// Armazenamento em memória (fallback)
const memoryStore = new Map<string, { count: number; resetTime: number }>();
const requestQueue = new Map<string, { active: number; waiting: any[] }>();

// Configurações
const CONFIG = {
  RATE_LIMIT_WINDOW: 60 * 1000,
  RATE_LIMIT_MAX_REQUESTS: 100,
  MAX_CONCURRENT_REQUESTS: 50,
  GLOBAL_MAX_CONCURRENT: 1000,
  QUEUE_TIMEOUT: 30000,
  MAX_QUEUE_SIZE: 200,
  FAILURE_THRESHOLD: 5,
  CIRCUIT_TIMEOUT: 60000,
};

let globalConcurrentRequests = 0;
const circuitBreaker = {
  failures: 0,
  isOpen: false,
  lastFailureTime: 0,
};

const getClientKey = (req: Request): string => {
  return (req as any).user?.id || req.ip || 'unknown';
};

/**
 * Traffic Manager Middleware
 */
export const trafficManager = (options = {}) => {
  const config = { ...CONFIG, ...options };

  return async (req: Request, res: Response, next: NextFunction) => {
    const clientKey = getClientKey(req);
    const startTime = Date.now();

    // 1. Circuit Breaker
    if (circuitBreaker.isOpen) {
      if (Date.now() - circuitBreaker.lastFailureTime < config.CIRCUIT_TIMEOUT) {
        return res.status(503).json({ error: 'SERVICE_UNAVAILABLE', message: 'Sistema em sobrecarga.' });
      }
      circuitBreaker.isOpen = false;
      circuitBreaker.failures = 0;
    }

    // 2. Global Concurrency
    if (globalConcurrentRequests >= config.GLOBAL_MAX_CONCURRENT) {
      circuitBreaker.failures++;
      if (circuitBreaker.failures >= config.FAILURE_THRESHOLD) {
        circuitBreaker.isOpen = true;
        circuitBreaker.lastFailureTime = Date.now();
      }
      return res.status(503).json({ error: 'SERVER_OVERLOAD' });
    }

    // 3. Rate Limiting
    const key = `ratelimit:${clientKey}`;
    let isAllowed = true;
    if (redisClient?.isOpen) {
      const count = await redisClient.incr(key);
      if (count === 1) await redisClient.expire(key, Math.ceil(config.RATE_LIMIT_WINDOW / 1000));
      isAllowed = count <= config.RATE_LIMIT_MAX_REQUESTS;
    } else {
      const record = memoryStore.get(key) || { count: 0, resetTime: Date.now() + config.RATE_LIMIT_WINDOW };
      if (Date.now() > record.resetTime) {
        record.count = 1;
        record.resetTime = Date.now() + config.RATE_LIMIT_WINDOW;
      } else {
        record.count++;
      }
      memoryStore.set(key, record);
      isAllowed = record.count <= config.RATE_LIMIT_MAX_REQUESTS;
    }

    if (!isAllowed) {
      return res.status(429).json({ error: 'RATE_LIMIT_EXCEEDED' });
    }

    // 4. Concurrency & Queueing Logic
    const queue = requestQueue.get(clientKey) || { active: 0, waiting: [] };
    if (queue.active >= config.MAX_CONCURRENT_REQUESTS) {
      if (queue.waiting.length >= config.MAX_QUEUE_SIZE) {
        return res.status(429).json({ error: 'QUEUE_FULL' });
      }
      
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('QUEUE_TIMEOUT')), config.QUEUE_TIMEOUT);
        queue.waiting.push({ resolve, timeout });
        requestQueue.set(clientKey, queue);
      }).catch(err => {
         return res.status(408).json({ error: err.message });
      });
    }

    // Success - Process Request
    queue.active++;
    globalConcurrentRequests++;
    requestQueue.set(clientKey, queue);

    const cleanup = () => {
      queue.active--;
      globalConcurrentRequests--;
      if (queue.waiting.length > 0) {
        const nextReq = queue.waiting.shift();
        clearTimeout(nextReq.timeout);
        nextReq.resolve();
      }
      res.removeListener('finish', cleanup);
      res.removeListener('close', cleanup);
    };

    res.on('finish', cleanup);
    res.on('close', cleanup);

    next();
  };
};
