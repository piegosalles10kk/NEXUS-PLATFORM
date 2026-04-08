/**
 * acme.service.ts
 *
 * Auto-SSL via ACME HTTP-01 challenge (Let's Encrypt).
 *
 * Flow:
 *   1. Client sets customDomain on a DePINApp
 *   2. verifyDns() confirms CNAME points to our gateway
 *   3. provisionCert() starts the ACME HTTP-01 challenge:
 *      - stores the token+keyAuth in Redis
 *      - the Express route /.well-known/acme-challenge/:token reads from Redis
 *      - requests the cert from Let's Encrypt CA
 *      - stores the cert+key in Redis (loaded by the HTTPS SNI callback)
 *   4. cert is auto-renewed 30 days before expiry by the renewal cron
 *
 * Dependencies: acme-client (npm install acme-client)
 */
import crypto from 'crypto';
import { getRedisClient } from '../config/redis';
import prisma from '../config/database';

// ── Challenge token store ─────────────────────────────────────────────────────

const CHALLENGE_PREFIX = 'acme:challenge:';
const CERT_PREFIX      = 'acme:cert:';

export async function storeChallenge(token: string, keyAuth: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.set(`${CHALLENGE_PREFIX}${token}`, keyAuth, { EX: 300 }); // 5 min TTL
}

export async function getChallenge(token: string): Promise<string | null> {
  const redis = await getRedisClient();
  return redis.get(`${CHALLENGE_PREFIX}${token}`);
}

// ── Certificate store (in-memory + Redis) ────────────────────────────────────

interface CertBundle {
  cert: string;       // PEM chain
  key:  string;       // PEM private key
  expiresAt: number;  // Unix timestamp
}

const certCache = new Map<string, CertBundle>();

export async function storeCert(domain: string, cert: string, key: string): Promise<void> {
  const redis = await getRedisClient();
  const expiresAt = Date.now() + 90 * 24 * 3600 * 1000; // ~90 days (Let's Encrypt)
  const bundle: CertBundle = { cert, key, expiresAt };
  certCache.set(domain, bundle);
  await redis.set(`${CERT_PREFIX}${domain}`, JSON.stringify(bundle), { EX: 90 * 24 * 3600 });
}

export async function getCert(domain: string): Promise<CertBundle | null> {
  if (certCache.has(domain)) return certCache.get(domain)!;
  const redis = await getRedisClient();
  const raw = await redis.get(`${CERT_PREFIX}${domain}`);
  if (!raw) return null;
  const bundle = JSON.parse(raw) as CertBundle;
  certCache.set(domain, bundle);
  return bundle;
}

// ── DNS verification ──────────────────────────────────────────────────────────

const GATEWAY_HOSTNAME = process.env.GATEWAY_HOSTNAME ?? 'gateway.nexus.cloud';

export async function verifyDns(domain: string): Promise<boolean> {
  try {
    // Use the dns module to check CNAME
    const { Resolver } = await import('dns/promises');
    const resolver = new Resolver();
    const records = await resolver.resolveCname(domain);
    return records.some(r => r === GATEWAY_HOSTNAME || r === GATEWAY_HOSTNAME + '.');
  } catch {
    return false;
  }
}

// ── ACME provisioning ─────────────────────────────────────────────────────────

export async function provisionCert(appId: string, domain: string): Promise<void> {
  // Mark as PENDING in DB
  await prisma.dePINApp.update({
    where: { id: appId },
    data: { sslStatus: 'PENDING' },
  });

  try {
    // Dynamic import of acme-client (optional dep)
    let acme: any;
    try {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — acme-client is an optional runtime dependency without bundled types
      acme = await import('acme-client');
    } catch {
      throw new Error('acme-client not installed. Run: npm install acme-client');
    }

    const client = new acme.Client({
      directoryUrl: acme.directory.letsencrypt.production,
      accountKey: await acme.crypto.createPrivateKey(),
    });

    const [key, csr] = await acme.crypto.createCsr({ commonName: domain });

    const cert = await client.auto({
      csr,
      email: process.env.ACME_EMAIL ?? 'admin@nexus.cloud',
      termsOfServiceAgreed: true,
      challengeCreateFn: async (_authz: any, _challenge: any, keyAuthorization: string) => {
        const token = _challenge.token;
        await storeChallenge(token, keyAuthorization);
      },
      challengeRemoveFn: async (_authz: any, _challenge: any) => {
        // Token expires automatically via Redis TTL
      },
    });

    await storeCert(domain, cert, key.toString());

    await prisma.dePINApp.update({
      where: { id: appId },
      data: { sslStatus: 'ACTIVE' },
    });

    console.log(`[acme] Certificate issued for ${domain}`);
  } catch (err) {
    console.error(`[acme] Failed to provision cert for ${domain}:`, err);
    await prisma.dePINApp.update({
      where: { id: appId },
      data: { sslStatus: 'FAILED' },
    });
  }
}

// ── Renewal cron (call daily) ─────────────────────────────────────────────────

export async function renewExpiringCerts(): Promise<void> {
  const apps = await prisma.dePINApp.findMany({
    where: { sslStatus: 'ACTIVE', customDomain: { not: null } },
    select: { id: true, customDomain: true },
  });

  const thirtyDaysMs = 30 * 24 * 3600 * 1000;
  const now = Date.now();

  for (const app of apps) {
    if (!app.customDomain) continue;
    const bundle = await getCert(app.customDomain);
    if (!bundle) continue;
    if (bundle.expiresAt - now < thirtyDaysMs) {
      console.log(`[acme] Renewing cert for ${app.customDomain}...`);
      await provisionCert(app.id, app.customDomain);
    }
  }
}

// ── SNI callback for the HTTPS server ────────────────────────────────────────
// Wire this to tls.createServer({ SNICallback })

export async function sniCallback(
  servername: string,
  cb: (err: Error | null, ctx?: any) => void,
): Promise<void> {
  try {
    const bundle = await getCert(servername);
    if (!bundle) { cb(null); return; }

    const tls = await import('tls');
    const ctx = tls.createSecureContext({
      cert: bundle.cert,
      key:  bundle.key,
    });
    cb(null, ctx);
  } catch (err) {
    cb(err instanceof Error ? err : new Error(String(err)));
  }
}

// ── Domain assignment helper ─────────────────────────────────────────────────

export async function assignDomain(appId: string, domain: string): Promise<{ dnsOk: boolean }> {
  const dnsOk = await verifyDns(domain);

  await prisma.dePINApp.update({
    where: { id: appId },
    data: {
      customDomain: domain,
      sslStatus: 'PENDING',
    },
  });

  if (dnsOk) {
    // Fire-and-forget provisioning
    provisionCert(appId, domain).catch(console.error);
  }

  return { dnsOk };
}

// ── Random token helper (used in tests) ──────────────────────────────────────
export function randomToken() {
  return crypto.randomBytes(20).toString('hex');
}
