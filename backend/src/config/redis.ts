import { createClient, RedisClientType } from 'redis';
import { env } from './env';

let redisClient: RedisClientType | null = null;
let redisPromise: Promise<RedisClientType> | null = null;

export const getRedisClient = async (): Promise<RedisClientType> => {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  if (redisPromise) {
    return redisPromise;
  }

  redisPromise = (async () => {
    const client = createClient({
      url: env.REDIS_URL,
    });

    client.on('error', (err) => console.error('Redis Client Error', err));

    await client.connect();
    redisClient = client as RedisClientType;
    return redisClient;
  })();

  try {
    const client = await redisPromise;
    return client;
  } finally {
    redisPromise = null;
  }
};

export const closeRedis = async () => {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
};
