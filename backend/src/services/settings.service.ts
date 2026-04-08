import prismaClient from '../config/database';
import { encrypt, decrypt } from './crypto.service';
import { env } from '../config/env';

const prisma = prismaClient;

// ─── In-memory cache ───────────────────────────────────────────────────────
interface CacheEntry { value: string; expiresAt: number }
const cache = new Map<string, CacheEntry>();
const TTL = 60_000; // 1 minute

function getCached(key: string): string | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key: string, value: string) {
  cache.set(key, { value, expiresAt: Date.now() + TTL });
}

export function invalidateCache(key: string) {
  cache.delete(key);
}

// ─── CRUD ───────────────────────────────────────────────────────────────────
export async function getSetting(key: string): Promise<string | null> {
  const hit = getCached(key);
  if (hit !== null) return hit;

  const row = await prisma.systemSetting.findUnique({ where: { key } });
  if (!row) return null;

  const value = decrypt(row.value);
  setCached(key, value);
  return value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const encrypted = encrypt(value);
  await prisma.systemSetting.upsert({
    where: { key },
    update: { value: encrypted },
    create: { key, value: encrypted },
  });
  setCached(key, value);
}

export async function deleteSetting(key: string): Promise<void> {
  await prisma.systemSetting.deleteMany({ where: { key } });
  invalidateCache(key);
}

export async function isSettingSet(key: string): Promise<boolean> {
  const hit = getCached(key);
  if (hit !== null) return true;
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return row !== null;
}

// ─── Webhook secret helper ──────────────────────────────────────────────────
/** Returns the active GitHub webhook secret (DB takes precedence over env). */
export async function getWebhookSecret(): Promise<string> {
  const dbSecret = await getSetting('GITHUB_WEBHOOK_SECRET');
  return dbSecret ?? env.GITHUB_WEBHOOK_SECRET;
}
