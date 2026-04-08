import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const envSchema = z.object({
  PORT: z.string().default('3001').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  GITHUB_WEBHOOK_SECRET: z.string().min(1, 'GITHUB_WEBHOOK_SECRET is required'),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  EMAIL_USER: z.string().transform((v: string) => v === '' ? undefined : v).pipe(z.string().email('EMAIL_USER must be a valid email').optional()),
  EMAIL_PASS: z.string().transform((v: string) => v === '' ? undefined : v).pipe(z.string().optional()),
  FRONTEND_URL: z.string().url('FRONTEND_URL must be a valid URL').default('http://localhost:5173'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT_CHECK_HOST: z.string().default('127.0.0.1'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
