/**
 * wallet.service.ts
 *
 * Ledger de dupla entrada para o marketplace DePIN.
 *
 * - Consumer gasta USD ao consumir recursos (SPEND)
 * - Provider ganha USD ao fornecer recursos (EARN)
 * - Plataforma retém comissão configurável (default 20%)
 *
 * O cron consolidateDailyUsage() deve ser chamado diariamente às 00:00 UTC.
 */
import prisma from '../config/database';
import { computeWindowCost, transitEarningsPerGb } from './pricing.service';

const PLATFORM_COMMISSION = 0.20; // 20 % platform fee

async function getCommission(): Promise<number> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: 'platform_commission' } });
    return row ? parseFloat(row.value) : PLATFORM_COMMISSION;
  } catch {
    return PLATFORM_COMMISSION;
  }
}

// ── Ensure wallet exists ──────────────────────────────────────────────────────

export async function ensureWallet(userId: string) {
  return prisma.wallet.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

// ── Debit Consumer ────────────────────────────────────────────────────────────

export async function debitConsumer(
  userId: string,
  amountUsd: number,
  description: string,
  metadata?: object,
) {
  const wallet = await ensureWallet(userId);
  if (wallet.balanceUsd < amountUsd) {
    throw new Error('Saldo insuficiente.');
  }
  await prisma.$transaction([
    prisma.wallet.update({
      where: { id: wallet.id },
      data: { balanceUsd: { decrement: amountUsd }, spentUsd: { increment: amountUsd } },
    }),
    prisma.ledgerTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'SPEND',
        amountUsd,
        description,
        metadata: metadata as any,
      },
    }),
  ]);
}

// ── Credit Provider ───────────────────────────────────────────────────────────

export async function creditProvider(
  userId: string,
  amountUsd: number,
  description: string,
  metadata?: object,
) {
  const wallet = await ensureWallet(userId);
  await prisma.$transaction([
    prisma.wallet.update({
      where: { id: wallet.id },
      data: { balanceUsd: { increment: amountUsd }, earnedUsd: { increment: amountUsd } },
    }),
    prisma.ledgerTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'EARN',
        amountUsd,
        description,
        metadata: metadata as any,
      },
    }),
  ]);
}

// ── Deposit ───────────────────────────────────────────────────────────────────

export async function deposit(userId: string, amountUsd: number) {
  if (amountUsd <= 0) throw new Error('Valor inválido.');
  const wallet = await ensureWallet(userId);
  await prisma.$transaction([
    prisma.wallet.update({
      where: { id: wallet.id },
      data: { balanceUsd: { increment: amountUsd } },
    }),
    prisma.ledgerTransaction.create({
      data: { walletId: wallet.id, type: 'DEPOSIT', amountUsd, description: 'Depósito manual' },
    }),
  ]);
}

// ── Cashout request ───────────────────────────────────────────────────────────

export async function requestCashout(userId: string, amountUsd: number, pixKey?: string) {
  if (amountUsd <= 0) throw new Error('Valor inválido.');
  const wallet = await ensureWallet(userId);
  if (wallet.balanceUsd < amountUsd) throw new Error('Saldo insuficiente.');

  return prisma.$transaction(async (tx) => {
    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balanceUsd: { decrement: amountUsd } },
    });
    await tx.ledgerTransaction.create({
      data: { walletId: wallet.id, type: 'WITHDRAW', amountUsd, description: 'Solicitação de saque' },
    });
    return tx.payoutRequest.create({
      data: { walletId: wallet.id, amountUsd, pixKey },
    });
  });
}

// ── Wallet balance query ──────────────────────────────────────────────────────

export async function getWallet(userId: string) {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    include: {
      transactions: {
        orderBy: { createdAt: 'desc' },
        take: 50,
      },
      payouts: {
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
    },
  });
  return wallet;
}

// ── Daily consolidation cron ──────────────────────────────────────────────────
// Call this every day at 00:00 UTC to convert UsageRecords into Ledger entries.

export async function consolidateDailyUsage(): Promise<void> {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  yesterday.setUTCHours(0, 0, 0, 0);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const commission = await getCommission();

  // Fetch all unbilled usage records from yesterday
  const records = await prisma.usageRecord.findMany({
    where: {
      windowStart: { gte: yesterday },
      windowEnd:   { lt: today },
      billedUsd:   0,
    },
    include: {
      app: { select: { id: true, name: true, priceMultiplier: true } },
    },
  });

  if (records.length === 0) {
    console.log('[wallet] consolidateDailyUsage: nothing to bill for', yesterday.toISOString().slice(0, 10));
    return;
  }

  // Group by app → node
  const grouped: Record<string, typeof records> = {};
  for (const r of records) {
    const key = `${r.appId}::${r.nodeId}`;
    grouped[key] = grouped[key] ?? [];
    grouped[key].push(r);
  }

  for (const [key, rows] of Object.entries(grouped)) {
    const [appId, nodeId] = key.split('::');
    const priceMultiplier = rows[0].app?.priceMultiplier ?? 1.0;

    // Fetch node for country (regional pricing)
    const node = await prisma.node.findUnique({ where: { id: nodeId } });

    // Aggregate window usage
    const totalCpuMs              = rows.reduce((s, r) => s + r.cpuMs,                                    BigInt(0));
    const totalRamMbS             = rows.reduce((s, r) => s + r.ramMbS,                                   BigInt(0));
    const totalNetRxBytes         = rows.reduce((s, r) => s + r.netRxBytes,                               BigInt(0));
    const totalNetTxBytes         = rows.reduce((s, r) => s + r.netTxBytes,                               BigInt(0));
    const totalNetworkTransitBytes = rows.reduce((s, r) => s + ((r as any).networkTransitBytes ?? BigInt(0)), BigInt(0));

    // T9.3 — compute workload cost + transit cost separately
    const cost = computeWindowCost({
      cpuMs:                totalCpuMs,
      ramMbS:               totalRamMbS,
      netRxBytes:           totalNetRxBytes,
      netTxBytes:           totalNetTxBytes,
      networkTransitBytes:  totalNetworkTransitBytes,
      country:              node?.country,
      priceMultiplier,
    });

    // T9.2 — provider gets surge bonus: they earn on the surge multiplier even if
    // the consumer paid the locked (lower) price at deploy time.
    const grossUsd      = cost.totalUsd;
    const providerEarns = grossUsd * (1 - commission);

    // Mark records as billed
    await prisma.usageRecord.updateMany({
      where: { id: { in: rows.map(r => r.id) } },
      data: { billedUsd: grossUsd / rows.length },
    });

    if (!node) continue;

    // Find provider user by node token claim (node token encodes userId as subject)
    // Fallback: credit generic "platform" wallet if no dedicated provider user
    try {
      const providerUser = await (prisma as any).user.findFirst({
        where: { role: 'ADM' }, // TODO: link Node → User in schema for proper provider attribution
      });
      if (providerUser) {
        await creditProvider(
          providerUser.id,
          providerEarns,
          `Earnings for node ${node.name} — ${yesterday.toISOString().slice(0, 10)}`,
          { appId, nodeId, date: yesterday.toISOString().slice(0, 10) },
        );
      }
    } catch (e) {
      console.error('[wallet] consolidateDailyUsage: credit error', e);
    }

    console.log(
      `[wallet] billed app=${appId} node=${nodeId}` +
      ` compute=$${(cost.cpuUsd + cost.ramUsd + cost.gpuUsd).toFixed(6)}` +
      ` transit=$${cost.transitUsd.toFixed(6)}` +
      ` gross=$${grossUsd.toFixed(6)} providerNet=$${providerEarns.toFixed(6)}`,
    );
  }
}

// ── T9.3 — Immediate transit billing (per-event, not daily) ──────────────────

/**
 * Called by the transit monitor whenever a node finishes a streaming session.
 * Bills the consumer for transit bytes and credits the provider immediately
 * (no waiting for the daily cron) since transit sessions can be short-lived.
 */
export async function billTransitSession(opts: {
  nodeId:        string;
  consumerId:    string;
  providerId:    string;
  transitBytes:  bigint;
  surgeMultiplier?: number;
}): Promise<void> {
  const node = await prisma.node.findUnique({ where: { id: opts.nodeId } });
  const commission = await getCommission();

  const perGb   = transitEarningsPerGb({ country: node?.country, surge: opts.surgeMultiplier ?? 1.0 });
  const totalGb = Number(opts.transitBytes) / (1024 ** 3);
  const grossUsd = totalGb * perGb;
  if (grossUsd < 0.000001) return; // skip dust

  const providerEarns = grossUsd * (1 - commission);

  await debitConsumer(
    opts.consumerId,
    grossUsd,
    `Nexus Flow transit — node ${opts.nodeId}`,
    { nodeId: opts.nodeId, transitBytes: opts.transitBytes.toString() },
  );

  await creditProvider(
    opts.providerId,
    providerEarns,
    `Transit earnings — node ${opts.nodeId}`,
    { nodeId: opts.nodeId, transitBytes: opts.transitBytes.toString() },
  );

  console.log(
    `[wallet] transit billed nodeId=${opts.nodeId}` +
    ` ${(totalGb * 1024).toFixed(1)} MB gross=$${grossUsd.toFixed(6)}` +
    ` providerNet=$${providerEarns.toFixed(6)}`,
  );
}
