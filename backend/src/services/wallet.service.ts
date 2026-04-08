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

// ── Preços base (USD) ─────────────────────────────────────────────────────────
const BASE_PRICES = {
  cpuPerMs:          0.00000001,
  ramPerMbS:         0.00000002,
  egressPerByte:     0.000000001,
  platformCommission: 0.20,
};

async function getPrices() {
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: ['cpu_price_per_ms', 'ram_price_per_mb_s', 'egress_price_per_byte', 'platform_commission'] } },
    });
    const m = Object.fromEntries(rows.map((r: any) => [r.key, parseFloat(r.value)]));
    return {
      cpuPerMs:          m['cpu_price_per_ms']       ?? BASE_PRICES.cpuPerMs,
      ramPerMbS:         m['ram_price_per_mb_s']     ?? BASE_PRICES.ramPerMbS,
      egressPerByte:     m['egress_price_per_byte']  ?? BASE_PRICES.egressPerByte,
      platformCommission: m['platform_commission']   ?? BASE_PRICES.platformCommission,
    };
  } catch {
    return BASE_PRICES;
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

  const prices = await getPrices();

  // Fetch all unbilled usage records from yesterday
  const records = await prisma.usageRecord.findMany({
    where: {
      windowStart: { gte: yesterday },
      windowEnd:   { lt: today },
      billedUsd:   0,
    },
    include: {
      app: {
        select: { id: true, name: true, priceMultiplier: true },
      },
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

    const cpuMs      = rows.reduce((s, r) => s + Number(r.cpuMs),      0);
    const ramMbS     = rows.reduce((s, r) => s + Number(r.ramMbS),     0);
    const netTxBytes = rows.reduce((s, r) => s + Number(r.netTxBytes), 0);

    const grossUsd =
      (cpuMs * prices.cpuPerMs + ramMbS * prices.ramPerMbS + netTxBytes * prices.egressPerByte)
      * priceMultiplier;

    const providerEarns = grossUsd * (1 - prices.platformCommission);

    // Mark records as billed
    await prisma.usageRecord.updateMany({
      where: { id: { in: rows.map(r => r.id) } },
      data: { billedUsd: grossUsd / rows.length },
    });

    // Find node owner to credit
    const node = await prisma.node.findUnique({ where: { id: nodeId } });
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
