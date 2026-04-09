/**
 * audit.service.ts  (Sprint 16.2)
 *
 * Immutable audit trail with SHA-256 integrity signatures.
 * Every sensitive admin action must be recorded here.
 */

import crypto from 'crypto';
import prisma from '../config/database';

export type AuditAction =
  | 'BAN' | 'UNBAN' | 'MINT' | 'BURN'
  | 'DELETE_USER' | 'HALT' | 'CREATE_INVITE'
  | 'NODE_TERMINATE' | 'APP_REMOVE'
  | 'BENCHMARK' | 'STRESS_TEST';

export interface AuditEntry {
  actorId?:  string;
  action:    AuditAction;
  targetId?: string;
  ipAddress?: string;
  payload?:  object;
}

/**
 * Writes an immutable audit log entry.
 * signature = SHA-256(action + targetId + iso-timestamp)
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  const ts  = new Date().toISOString();
  const raw = `${entry.action}:${entry.targetId ?? ''}:${ts}`;
  const signature = crypto.createHash('sha256').update(raw).digest('hex');

  await (prisma.auditLog as any).create({
    data: {
      actorId:   entry.actorId,
      action:    entry.action,
      targetId:  entry.targetId,
      ipAddress: entry.ipAddress,
      payload:   entry.payload as any,
      signature,
    },
  });
}

/**
 * Reads audit logs with optional filters.
 */
export async function readAuditLogs(opts: {
  actorId?:  string;
  action?:   AuditAction;
  targetId?: string;
  limit?:    number;
  offset?:   number;
}) {
  const { actorId, action, targetId, limit = 50, offset = 0 } = opts;
  return (prisma.auditLog as any).findMany({
    where: {
      ...(actorId  ? { actorId }  : {}),
      ...(action   ? { action }   : {}),
      ...(targetId ? { targetId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take:    limit,
    skip:    offset,
    include: { actor: { select: { id: true, name: true, email: true } } },
  });
}
