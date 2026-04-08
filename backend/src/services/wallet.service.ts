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
import { computeWindowCost } from './pricing.service';

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
    const totalCpuMs      = rows.reduce((s, r) => s + r.cpuMs,      BigInt(0));
    const totalRamMbS     = rows.reduce((s, r) => s + r.ramMbS,     BigInt(0));
    const totalNetRxBytes = rows.reduce((s, r) => s + r.netRxBytes, BigInt(0));
    const totalNetTxBytes = rows.reduce((s, r) => s + r.netTxBytes, BigInt(0));

    // Use pricing.service for accurate cost (regional + surge)
    const cost = computeWindowCost({
      cpuMs:          totalCpuMs,
      ramMbS:         totalRamMbS,
      netRxBytes:     totalNetRxBytes,
      netTxBytes:     totalNetTxBytes,
      country:        node?.country,
      priceMultiplier,
    });

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

    console.log(`[wallet] billed app=${appId} node=${nodeId} gross=$${grossUsd.toFixed(6)} providerNet=$${providerEarns.toFixed(6)}`);
  }
}
