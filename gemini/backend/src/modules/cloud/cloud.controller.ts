import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import prisma from '../../config/database';
import { encrypt, decrypt } from '../../services/crypto.service';
import { provisionServer, destroyServer } from '../../services/terraform.service';
import { env } from '../../config/env';
import * as fs from 'fs';
import * as path from 'path';

const db = prisma as any;

// ─── Providers ─────────────────────────────────────────────────────────────────

export async function listProviders(_req: Request, res: Response, next: NextFunction) {
  try {
    const providers = await db.cloudProvider.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, type: true, region: true, createdAt: true, _count: { select: { servers: true } } },
    });
    res.json({ status: 'success', data: { providers } });
  } catch (err) { next(err); }
}

export async function createProvider(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, type, apiKey, apiKeyId, region, tenantId, subscriptionId } = req.body as {
      name: string;
      type: 'AWS' | 'DIGITALOCEAN' | 'AZURE' | 'GCP';
      apiKey: string;
      apiKeyId?: string;
      region: string;
      tenantId?: string;        // Azure
      subscriptionId?: string;  // Azure
    };

    if (!name || !type || !apiKey || !region) {
      res.status(400).json({ status: 'error', message: 'name, type, apiKey e region são obrigatórios.' });
      return;
    }

    if (type === 'AZURE' && (!apiKeyId || !tenantId || !subscriptionId)) {
      res.status(400).json({ status: 'error', message: 'Azure requer clientId, tenantId e subscriptionId.' });
      return;
    }

    if (type === 'GCP') {
      try { JSON.parse(apiKey); } catch {
        res.status(400).json({ status: 'error', message: 'GCP: o campo Service Account JSON é inválido.' });
        return;
      }
    }

    // Encode credentials per provider type before encrypting:
    //   DO    → plain token
    //   AWS   → "accessKeyId:secretKey"
    //   AZURE → JSON {clientId, tenantId, subscriptionId, clientSecret}
    //   GCP   → raw service-account JSON string (already JSON)
    let credPayload: string;
    if (type === 'AZURE') {
      credPayload = JSON.stringify({ clientId: apiKeyId, tenantId, subscriptionId, clientSecret: apiKey });
    } else if (type === 'AWS') {
      credPayload = apiKeyId ? `${apiKeyId}:${apiKey}` : apiKey;
    } else {
      credPayload = apiKey; // DO: token string | GCP: service-account JSON string
    }
    const encryptedApiKey = encrypt(credPayload);

    const provider = await db.cloudProvider.create({
      data: { name, type, encryptedApiKey, region },
      select: { id: true, name: true, type: true, region: true, createdAt: true },
    });

    res.status(201).json({ status: 'success', data: { provider } });
  } catch (err) { next(err); }
}

export async function deleteProvider(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    await db.cloudProvider.delete({ where: { id } });
    res.json({ status: 'success', message: 'Provider removido.' });
  } catch (err) { next(err); }
}

// ─── Servers ──────────────────────────────────────────────────────────────────

export async function listServers(req: Request<{ providerId: string }>, res: Response, next: NextFunction) {
  try {
    const servers = await db.cloudServer.findMany({
      where: { providerId: req.params.providerId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ status: 'success', data: { servers } });
  } catch (err) { next(err); }
}

/** GET /api/cloud/servers — flat list of all servers across all providers (ADM + TECNICO) */
export async function listAllServers(_req: Request, res: Response, next: NextFunction) {
  try {
    const servers = await db.cloudServer.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        provider: { select: { name: true, type: true } },
      },
    });
    res.json({ status: 'success', data: { servers } });
  } catch (err) { next(err); }
}

export async function provisionNewServer(
  req: Request<{ providerId: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const { providerId } = req.params;
    const { name, instanceType, sshPublicKey, region } = req.body as {
      name: string; instanceType: string; sshPublicKey: string; region?: string;
    };

    if (!name || !instanceType || !sshPublicKey) {
      res.status(400).json({ status: 'error', message: 'name, instanceType e sshPublicKey são obrigatórios.' });
      return;
    }

    const provider = await db.cloudProvider.findUnique({ where: { id: providerId } });
    if (!provider) { res.status(404).json({ status: 'error', message: 'Provider não encontrado.' }); return; }

    // Decrypt and parse credentials per provider type
    const decrypted = decrypt(provider.encryptedApiKey);
    let apiKey = decrypted;
    let apiKeyId: string | undefined;
    let tenantId: string | undefined;
    let subscriptionId: string | undefined;
    let gcpProjectId: string | undefined;

    if (provider.type === 'AZURE') {
      const creds = JSON.parse(decrypted) as {
        clientId: string; tenantId: string; subscriptionId: string; clientSecret: string;
      };
      apiKey = creds.clientSecret;
      apiKeyId = creds.clientId;
      tenantId = creds.tenantId;
      subscriptionId = creds.subscriptionId;
    } else if (provider.type === 'GCP') {
      // apiKey IS the service-account JSON; extract project_id from it
      const sa = JSON.parse(decrypted) as { project_id?: string };
      gcpProjectId = sa.project_id;
    } else if (provider.type === 'AWS' && decrypted.includes(':')) {
      const parts = decrypted.split(':');
      apiKeyId = parts[0];
      apiKey = parts.slice(1).join(':');
    }

    // Pre-create the Node record so the enrollment token is valid before the VM boots
    const persistentToken = crypto.randomBytes(32).toString('hex');
    const node = await prisma.node.create({
      data: {
        name,
        os: 'linux',
        arch: 'amd64',
        token: persistentToken,
        status: 'OFFLINE',
      },
    });

    // Short-lived enrollment JWT (2h — enough time for cloud-init to run)
    const enrollmentToken = jwt.sign(
      { nodeId: node.id, purpose: 'enroll' },
      env.JWT_SECRET,
      { expiresIn: '2h' },
    );

    // Create server record (PROVISIONING) — link to Node via SystemSettings below
    const server = await db.cloudServer.create({
      data: {
        providerId,
        name,
        region: region ?? provider.region,
        instanceType,
        sshPublicKey,
        status: 'PROVISIONING',
      },
    });

    res.status(202).json({ status: 'success', data: { server } });

    // Provision asynchronously
    const logs: string[] = [];
    const platformUrl = env.FRONTEND_URL.replace('5173', '4500');
    try {
      const { ip, workDir } = await provisionServer(
        { type: provider.type, apiKey, apiKeyId, tenantId, subscriptionId, gcpProjectId, region: region ?? provider.region },
        { name, instanceType, sshPublicKey, enrollmentToken },
        platformUrl,
        (line) => { logs.push(line); console.log(`[Terraform] ${line}`); },
      );

      await db.cloudServer.update({
        where: { id: server.id },
        data: { ip, status: 'RUNNING' },
      });

      // Persist workDir and nodeId for later (destroy + pipeline routing)
      const { setSetting } = await import('../../services/settings.service');
      await setSetting(`TERRAFORM_WORKDIR_${server.id}`, workDir);
      await setSetting(`NODE_ID_${server.id}`, node.id);
    } catch (err: any) {
      const errorMsg: string = err.message ?? String(err);
      // Append last Terraform log lines for context (up to 20 lines)
      const terraformTail = logs.slice(-20).join('\n');
      const fullError = terraformTail ? `${errorMsg}\n\n--- Terraform output (last 20 lines) ---\n${terraformTail}` : errorMsg;

      await db.cloudServer.update({
        where: { id: server.id },
        data: { status: 'ERROR', lastError: fullError },
      });
      // Clean up the orphaned node record on failure
      await prisma.node.delete({ where: { id: node.id } }).catch(() => {});
      console.error(`[Terraform] Provisioning failed for server ${server.id}:`, errorMsg);
    }
  } catch (err) { next(err); }
}

export async function deleteServer(
  req: Request<{ providerId: string; serverId: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const { serverId } = req.params;
    const server = await db.cloudServer.findUnique({ where: { id: serverId } });
    if (!server) { res.status(404).json({ status: 'error', message: 'Servidor não encontrado.' }); return; }

    res.json({ status: 'success', message: 'Destroy iniciado em background.' });

    try {
      const { getSetting, deleteSetting } = await import('../../services/settings.service');
      const workDir = await getSetting(`TERRAFORM_WORKDIR_${serverId}`);
      if (workDir) {
        await destroyServer(workDir, (line) => console.log(`[Terraform Destroy] ${line}`));
        await deleteSetting(`TERRAFORM_WORKDIR_${serverId}`);
      }
      const nodeId = await getSetting(`NODE_ID_${serverId}`);
      if (nodeId) {
        await prisma.node.delete({ where: { id: nodeId } }).catch(() => {});
        await deleteSetting(`NODE_ID_${serverId}`);
      }
    } catch (err: any) {
      console.error(`[Terraform] Destroy failed for ${serverId}:`, err.message);
    } finally {
      await db.cloudServer.delete({ where: { id: serverId } });
    }
  } catch (err) { next(err); }
}

export async function getServerStatus(
  req: Request<{ providerId: string; serverId: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const server = await db.cloudServer.findUnique({ where: { id: req.params.serverId } });
    if (!server) { res.status(404).json({ status: 'error', message: 'Servidor não encontrado.' }); return; }
    res.json({ status: 'success', data: { server } });
  } catch (err) { next(err); }
}

export async function restartServer(
  req: Request<{ providerId: string; serverId: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const { serverId } = req.params;
    const server = await db.cloudServer.findUnique({ where: { id: serverId } });
    if (!server) { res.status(404).json({ status: 'error', message: 'Servidor não encontrado.' }); return; }

    const { getSetting } = await import('../../services/settings.service');
    const nodeId = await getSetting(`NODE_ID_${serverId}`);

    if (nodeId) {
      const { getAgentSocket } = await import('../../services/agent-ws.service');
      const ws = getAgentSocket(nodeId);
      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'reboot' }));
        return res.json({ status: 'success', message: 'Comando de reinício enviado ao servidor via agente.' });
      }
    }

    res.json({ status: 'success', message: 'Reinício simulado. O Agente Nexus não está conectado no momento.' });
  } catch (err) { next(err); }
}

export async function getServerDetails(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;

    let server = await db.cloudServer.findUnique({
      where: { id },
      include: {
        provider: true,
        projects: {
          include: {
            instances: true
          }
        }
      }
    });

    let node: any = null;
    let isManual = false;

    if (server) {
      const { getSetting } = await import('../../services/settings.service');
      const nodeId = await getSetting(`NODE_ID_${id}`);
      if (nodeId) {
        node = await db.node.findUnique({ where: { id: nodeId } });
      }
    } else {
      node = await db.node.findUnique({ where: { id } });
      if (!node) {
        return res.status(404).json({ status: 'error', message: 'Servidor ou Node não encontrado.' });
      }
      isManual = true;
      server = {
        id: node.id,
        name: node.name,
        region: 'Local / On-Premise',
        instanceType: `${node.os}-${node.arch}`,
        ip: node.ipAddress,
        status: node.status === 'ONLINE' ? 'RUNNING' : 'STOPPED',
        agentConnected: node.status === 'ONLINE',
        agentVersion: node.version,
        projects: []
      } as any;
    }

    res.json({
      status: 'success',
      data: {
        server,
        node,
        isManual
      }
    });
  } catch (err) { next(err); }
}
