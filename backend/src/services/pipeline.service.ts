import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import prisma from '../config/database';
import { DeployStatus } from '@prisma/client';
import { decrypt } from './crypto.service';
import { executeSSHCommand } from './ssh.service';
import {
  buildImage,
  createAndStartContainer,
  stopAndRemoveContainer,
  ensureLbNetwork,
  connectContainerToLbNetwork,
  startNginxLb,
  updateNginxConfig,
  imageExists,
  tagImage,
} from './docker.service';
import { Server as SocketServer } from 'socket.io';
import { getAgentSocket } from './agent-ws.service';

export interface PipelineContext {
  projectId: string;
  deployId: string;
  repoUrl: string;
  branch: string;
  projectName: string;
  environmentType: 'LOCAL' | 'CLOUD' | 'NODE';
  nodeId?: string;
  clean?: boolean;
  commitHash?: string;
  commitMsg?: string;
  io: SocketServer;
  /** Accumulated log entries — initialized by runPipeline, used by finalize to persist. */
  _logs?: Array<{ step: string; message: string; type: string; timestamp: string }>;
}

// ─── Rollback error ───────────────────────────────────────────────────────────

/** Thrown when a deploy fails but the previous version was successfully restored. */
class RolledBackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RolledBackError';
  }
}

// ─── Cancellation ─────────────────────────────────────────────────────────────

const cancelledDeploys = new Set<string>();

export function cancelPipeline(deployId: string): void {
  cancelledDeploys.add(deployId);
}

function checkCancelled(ctx: PipelineContext): void {
  if (cancelledDeploys.has(ctx.deployId)) {
    cancelledDeploys.delete(ctx.deployId);
    throw new Error('Deploy cancelado pelo usuário');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolves the project's secrets into a plain key→value map (decrypted). */
async function getSecretsMap(projectId: string): Promise<Record<string, string>> {
  const rows = await prisma.projectSecret.findMany({ where: { projectId } });
  return Object.fromEntries(rows.map((r) => [r.keyName, decrypt(r.encryptedValue)]));
}

function parseTestResults(output: string): { passed: number; total: number } | null {
  // Jest: "Tests: 3 passed, 3 total" or "Tests: 1 failed, 2 passed, 3 total"
  const jestMatch = output.match(/Tests:\s+(?:\d+ failed,\s*)?(\d+) passed,\s*(\d+) total/);
  if (jestMatch) return { passed: parseInt(jestMatch[1], 10), total: parseInt(jestMatch[2], 10) };

  // Vitest: "✓ 3 tests passed"
  const vitestMatch = output.match(/(\d+)\s+tests?\s+passed/i);
  if (vitestMatch) {
    const passed = parseInt(vitestMatch[1], 10);
    return { passed, total: passed };
  }

  return null;
}

function emitLog(
  ctx: PipelineContext,
  step: string,
  message: string,
  type: 'info' | 'success' | 'error' | 'warning' = 'info',
): void {
  const entry = { step, message, type, timestamp: new Date().toISOString() };
  ctx._logs?.push(entry);
  ctx.io.to(`project:${ctx.projectId}`).emit('deploy:log', {
    deployId: ctx.deployId,
    ...entry,
  });
}

function emitStatus(ctx: PipelineContext, status: DeployStatus | 'RUNNING'): void {
  ctx.io.to(`project:${ctx.projectId}`).emit('deploy:status', {
    deployId: ctx.deployId,
    status,
  });
}

async function finalize(
  ctx: PipelineContext,
  status: 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'ROLLED_BACK',
  errorMessage?: string,
  testsPassed?: number,
  testsTotal?: number,
): Promise<void> {
  if (errorMessage) {
    emitLog(ctx, 'finalize', errorMessage, 'error');
  }

  await prisma.deployHistory.update({
    where: { id: ctx.deployId },
    data: {
      status: status as DeployStatus,
      logOutput: ctx._logs ?? [],
      ...(testsPassed !== undefined ? { testsPassed } : {}),
      ...(testsTotal  !== undefined ? { testsTotal  } : {}),
    },
  });

  emitStatus(ctx, status as DeployStatus);
  emitLog(ctx, 'finalize', `Deploy finalizado: ${status}`, status === 'SUCCESS' ? 'success' : 'error');
}

// ─── Helpers: run a command and stream output ─────────────────────────────────

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  onLog: (line: string) => void,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      shell: true,
      env: { ...process.env, ...env },
    });

    proc.stdout.on('data', (d: Buffer) => {
      d.toString().split('\n').filter(Boolean).forEach(onLog);
    });
    proc.stderr.on('data', (d: Buffer) => {
      d.toString().split('\n').filter(Boolean).forEach(onLog);
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command "${cmd} ${args.join(' ')}" exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

// ─── HTTP health check with retry ────────────────────────────────────────────

/**
 * GETs `url` up to 3 times with 5-second intervals.
 * Expects a 2xx response. On all failures, calls tryRollback.
 */
async function httpHealthCheck(
  ctx: PipelineContext,
  url: string,
  tryRollback: (reason: string) => Promise<never>,
): Promise<void> {
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY  = 5_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      emitLog(ctx, 'health-check', `GET ${url} (tentativa ${attempt}/${MAX_ATTEMPTS})…`, 'info');
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        emitLog(ctx, 'health-check', `${url} respondeu ${res.status} ✓`, 'success');
        return;
      }
      emitLog(ctx, 'health-check', `${url} respondeu ${res.status} — aguardando ${RETRY_DELAY / 1000}s`, 'warning');
    } catch (err: any) {
      emitLog(ctx, 'health-check', `${url} inacessível: ${err.message} — aguardando ${RETRY_DELAY / 1000}s`, 'warning');
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY));
    }
  }

  await tryRollback(`Health check falhou após ${MAX_ATTEMPTS} tentativas: ${url}`);
}

// ─── Local (automatic Docker) pipeline ───────────────────────────────────────

async function runAutomaticDockerPipeline(
  ctx: PipelineContext,
): Promise<{ testsPassed?: number; testsTotal?: number }> {
  const imageTag = ctx.projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const repoDir = path.join(process.cwd(), 'projects', imageTag);
  if (!fs.existsSync(path.join(process.cwd(), 'projects'))) {
    fs.mkdirSync(path.join(process.cwd(), 'projects'), { recursive: true });
  }

  try {
    // 1. Git clone or update
    const gitDir = path.join(repoDir, '.git');
    if (fs.existsSync(gitDir)) {
      emitLog(ctx, 'git-fetch', `Repo existe, atualizando (branch: ${ctx.branch})…`, 'info');
      try {
        await runCommand('git', ['fetch', '--depth', '1', 'origin', ctx.branch], repoDir, (line) => emitLog(ctx, 'git-fetch', line));
        await runCommand('git', ['reset', '--hard', 'FETCH_HEAD'], repoDir, (line) => emitLog(ctx, 'git-reset', line));
      } catch (err) {
        emitLog(ctx, 'git-error', 'Falha ao atualizar, re-clonando…', 'warning');
        fs.rmSync(repoDir, { recursive: true, force: true });
        fs.mkdirSync(repoDir, { recursive: true });
        await runCommand('git', ['clone', '--depth', '1', '--branch', ctx.branch, ctx.repoUrl, '.'], repoDir, (line) => emitLog(ctx, 'git-clone', line));
      }
    } else {
      if (!fs.existsSync(repoDir)) fs.mkdirSync(repoDir, { recursive: true });
      emitLog(ctx, 'git-clone', `Clonando ${ctx.repoUrl} (branch: ${ctx.branch})…`, 'info');
      await runCommand('git', ['clone', '--depth', '1', '--branch', ctx.branch, ctx.repoUrl, '.'], repoDir, (line) => emitLog(ctx, 'git-clone', line));
    }

    checkCancelled(ctx);

    // 2. Install dependencies
    emitLog(ctx, 'install', 'Instalando dependências…', 'info');
    await runCommand('npm', ['ci', '--prefer-offline'], repoDir,
      (line) => emitLog(ctx, 'install', line));

    checkCancelled(ctx);

    // 3. Run tests
    emitLog(ctx, 'test', 'Executando testes…', 'info');
    let testOutput = '';
    let testsPassed: number | undefined;
    let testsTotal: number | undefined;
    try {
      await runCommand(
        'npm',
        ['test', '--', '--passWithNoTests', '--ci'],
        repoDir,
        (line) => {
          testOutput += line + '\n';
          emitLog(ctx, 'test', line);
        },
      );
      const results = parseTestResults(testOutput);
      if (results) {
        testsPassed = results.passed;
        testsTotal  = results.total;
        emitLog(ctx, 'test', `Testes: ${results.passed}/${results.total} passaram`, 'success');
      } else {
        emitLog(ctx, 'test', 'Testes concluídos', 'success');
      }
    } catch (err: any) {
      emitLog(ctx, 'test', `Aviso: testes falharam — ${err.message}`, 'warning');
      // Don't abort — allow deploy to continue
    }

    checkCancelled(ctx);

    // 4. Fetch project config (proxy labels + LB + health check delay)
    // Cast to any: Prisma client type will be updated after `prisma db push`
    const projectData = await (prisma.project as any).findUnique({
      where: { id: ctx.projectId },
      select: {
        proxyHost: true, proxyPort: true,
        lbEnabled: true, lbPort: true, lbAppPort: true,
        lbHealthPath: true,
        healthCheckDelay: true,
        healthCheckUrl: true,
        requireGpu: true,
      },
    }) as {
      proxyHost: string | null; proxyPort: number | null;
      lbEnabled: boolean; lbPort: number | null; lbAppPort: number | null;
      lbHealthPath: string; healthCheckDelay: number; healthCheckUrl: string | null;
      requireGpu: boolean;
    } | null;
    const healthDelay = (projectData?.healthCheckDelay ?? 15) * 1_000;

    // 5. Rotate tags: current → previous (before overwriting)
    //    image:current = last confirmed-healthy build
    //    image:previous = the one before that (true rollback target)
    const hasCurrent = await imageExists(`${imageTag}:current`);
    if (hasCurrent) {
      try {
        await tagImage(`${imageTag}:current`, imageTag, 'previous');
        emitLog(ctx, 'docker-build', `Snapshot de rollback: ${imageTag}:previous ← current`, 'info');
      } catch { /* non-fatal */ }
    }

    // 6. Docker build
    emitLog(ctx, 'docker-build', `Construindo imagem ${imageTag}…`, 'info');
    await buildImage({
      context: repoDir,
      tag: imageTag,
      onLog: (line) => emitLog(ctx, 'docker-build', line),
    });
    emitLog(ctx, 'docker-build', `Imagem ${imageTag} construída com sucesso`, 'success');

    checkCancelled(ctx);

    // 7. Stop old container (best-effort)
    emitLog(ctx, 'deploy', `Substituindo container ${imageTag}…`, 'info');
    try { await stopAndRemoveContainer(imageTag); } catch { /* ignore */ }

    // 8. Build proxy-discovery labels
    const containerLabels: Record<string, string> = {};
    if (projectData?.proxyHost && projectData.proxyPort) {
      containerLabels['10kk.proxy.host'] = projectData.proxyHost;
      containerLabels['10kk.proxy.port'] = String(projectData.proxyPort);
    }

    // 9. Start new container
    const secrets = await getSecretsMap(ctx.projectId);
    const envVars = Object.entries(secrets).map(([k, v]) => `${k}=${v}`);

    const tryRollback = async (reason: string): Promise<never> => {
      emitLog(ctx, 'rollback', reason, 'error');
      if (!hasCurrent) throw new Error(reason + ' (sem versão anterior para restaurar)');

      emitLog(ctx, 'rollback', `Iniciando rollback para ${imageTag}:previous…`, 'warning');
      try { await stopAndRemoveContainer(imageTag); } catch { /* ignore */ }
      try {
        const rbContainer = await createAndStartContainer({
          name: imageTag,
          image: `${imageTag}:previous`,
          env: envVars,
          labels: containerLabels,
          // Rollback intentionally omits requireGpu to always succeed even
          // when the toolkit state is unclear.
        });
        await prisma.containerInstance.deleteMany({ where: { projectId: ctx.projectId, replicaIndex: 0 } });
        await prisma.containerInstance.create({
          data: { projectId: ctx.projectId, containerId: rbContainer.id, containerName: imageTag, replicaIndex: 0, status: 'RUNNING' },
        });
        emitLog(ctx, 'rollback', 'Rollback concluído — versão anterior restaurada', 'success');
        throw new RolledBackError(reason + ' — versão anterior restaurada automaticamente.');
      } catch (rbErr: any) {
        if (rbErr instanceof RolledBackError) throw rbErr;
        emitLog(ctx, 'rollback', `Rollback também falhou: ${rbErr.message}`, 'error');
        throw new Error(reason);
      }
    };

    let container: Awaited<ReturnType<typeof createAndStartContainer>>;
    try {
      container = await createAndStartContainer({
        name: imageTag,
        image: imageTag,
        env: envVars,
        labels: containerLabels,
        requireGpu: projectData?.requireGpu ?? false,
      });
    } catch (deployErr: any) {
      await tryRollback(`Falha ao iniciar container: ${deployErr.message}`);
    }

    // 10. Health check
    emitLog(ctx, 'health-check', `Aguardando inicialização (${healthDelay / 1000}s)…`, 'info');
    await new Promise((r) => setTimeout(r, healthDelay));
    checkCancelled(ctx);

    if (projectData?.healthCheckUrl) {
      // HTTP health check with 3 retries
      await httpHealthCheck(ctx, projectData.healthCheckUrl, tryRollback);
    } else {
      // Fallback: verify container is still running via Docker inspect
      try {
        const info = await container!.inspect();
        if (!info.State.Running) {
          await tryRollback(`Container parou imediatamente (exit code ${info.State.ExitCode})`);
        }
      } catch (inspectErr: any) {
        if (inspectErr instanceof RolledBackError) throw inspectErr;
        await tryRollback(`Container não está mais acessível: ${inspectErr.message}`);
      }
    }
    emitLog(ctx, 'health-check', 'Health check passou ✓', 'success');

    // 11. Promote new build as the confirmed-healthy current snapshot
    try { await tagImage(imageTag, imageTag, 'current'); } catch { /* non-fatal */ }

    // 12. Connect to LB network if load-balancer is enabled
    if (projectData?.lbEnabled) {
      await ensureLbNetwork();
      await connectContainerToLbNetwork(container!.id);
      await startNginxLb(imageTag, projectData.lbPort ?? 80);
      await updateNginxConfig(imageTag, [imageTag], projectData.lbAppPort ?? 3000);
    }

    // 13. Register container instance (replace index-0 record)
    await prisma.containerInstance.deleteMany({ where: { projectId: ctx.projectId, replicaIndex: 0 } });
    await prisma.containerInstance.create({
      data: { projectId: ctx.projectId, containerId: container!.id, containerName: imageTag, replicaIndex: 0, status: 'RUNNING' },
    });

    emitLog(ctx, 'deploy', `Container ${imageTag} iniciado com sucesso`, 'success');

    return { testsPassed, testsTotal };
  } finally {
    // Persistent repo remains in ./projects
  }
}

// ─── Cloud (agent WebSocket) pipeline ────────────────────────────────────────

async function runRemotePipeline(ctx: PipelineContext): Promise<void> {
  const stepLabel = ctx.environmentType === 'NODE' ? 'node-dispatch' : 'cloud-dispatch';
  emitLog(ctx, stepLabel, `Roteando deploy para agente ${ctx.environmentType === 'NODE' ? 'direto' : 'cloud'}…`, 'info');

  let nodeId = ctx.nodeId;

  if (ctx.environmentType === 'CLOUD') {
    // Resolve the cloud server and timeout config for this project
    const project = await prisma.project.findUnique({
      where: { id: ctx.projectId },
      select: { cloudServerId: true },
    });
    if (!project?.cloudServerId) {
      throw new Error('Projeto não possui servidor cloud configurado.');
    }

    // Find the connected Node for this cloud server via NODE_ID_<serverId> setting
    const settingKey = `NODE_ID_${project.cloudServerId}`;
    const setting = await prisma.systemSetting.findUnique({ where: { key: settingKey } }).catch(() => null);
    nodeId = setting?.value;

    if (!nodeId) {
      throw new Error(
        `Agente não encontrado para o servidor ${project.cloudServerId} ` +
        `(setting: ${settingKey} não configurado).`,
      );
    }
  }

  if (!nodeId) {
    throw new Error('ID do agente não definido para este deploy.');
  }

  const agentSocket = getAgentSocket(nodeId);
  if (!agentSocket) {
    throw new Error(`Agente ${nodeId} não está conectado.`);
  }

  // Collect secrets as env vars for the remote deploy
  const secrets = await getSecretsMap(ctx.projectId);

  // Fetch proxy labels + health check config
  // Cast to any: Prisma client type will be updated after `prisma db push`
  const projectConfig = await (prisma.project as any).findUnique({
    where: { id: ctx.projectId },
    select: {
      proxyHost: true,
      proxyPort: true,
      healthCheckUrl: true,
      healthCheckDelay: true,
      deployTimeoutMin: true,
      requireGpu: true,
    },
  }) as {
    proxyHost: string | null; proxyPort: number | null;
    healthCheckUrl: string | null; healthCheckDelay: number;
    deployTimeoutMin: number; requireGpu: boolean;
  } | null;

  // Send deploy command (agentSocket is verified non-null above)
  const ws = agentSocket;
  const imageName = ctx.projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  ws.send(JSON.stringify({
    type:             'command',
    action:           'deploy',
    repo:             ctx.repoUrl,
    branch:           ctx.branch,
    imageName,
    envVars:          secrets,
    proxyHost:        projectConfig?.proxyHost ?? '',
    proxyPort:        projectConfig?.proxyPort ?? 0,
    healthCheckUrl:   projectConfig?.healthCheckUrl ?? '',
    healthCheckDelay: projectConfig?.healthCheckDelay ?? 15,
    clean:            ctx.clean ?? false,
    requireGpu:       projectConfig?.requireGpu ?? false,
  }));
  emitLog(ctx, stepLabel, `Comando de deploy enviado ao agente ${nodeId}`, 'info');

  // Stream logs and wait for completion (per-project configurable timeout)
  const timeoutMs = (projectConfig?.deployTimeoutMin ?? 10) * 60 * 1_000;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', onMessage);
      reject(new Error(`Deploy remoto expirou após ${projectConfig?.deployTimeoutMin ?? 10} minutos`));
    }, timeoutMs);

    function onMessage(data: Buffer | string) {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'log_line') {
        emitLog(ctx, 'agent-logs', String(msg.message ?? msg.data ?? ''), 'info');
      } else if (msg.type === 'deploy_done') {
        clearTimeout(timeout);
        ws.removeListener('message', onMessage);
        emitLog(ctx, stepLabel, 'Deploy concluído com sucesso no servidor remoto.', 'success');
        resolve();
      } else if (msg.type === 'deploy_rolled_back') {
        clearTimeout(timeout);
        ws.removeListener('message', onMessage);
        emitLog(ctx, stepLabel, 'Deploy falhou no servidor remoto — versão anterior restaurada.', 'warning');
        reject(new RolledBackError(String(msg.message ?? 'Deploy falhou; versão anterior restaurada.')));
      } else if (msg.type === 'deploy_failed') {
        clearTimeout(timeout);
        ws.removeListener('message', onMessage);
        reject(new Error(String(msg.message ?? 'Deploy remoto falhou')));
      }
    }

    ws.on('message', onMessage);
  });
}

// ─── Workflow steps ───────────────────────────────────────────────────────────

async function runWorkflowSteps(ctx: PipelineContext): Promise<void> {
  const steps = await prisma.workflowStep.findMany({
    where: { projectId: ctx.projectId },
    orderBy: { order: 'asc' },
  });

  // Gather SSH credentials from associated cloud server (needed for REMOTE_SSH_COMMAND steps)
  let sshOpts: { host: string; username: string; privateKey?: string } | null = null;
  const project = await prisma.project.findUnique({
    where: { id: ctx.projectId },
    select: { cloudServerId: true },
  });
  if (project?.cloudServerId) {
    const cs = await prisma.cloudServer.findUnique({
      where: { id: project.cloudServerId },
      select: { ip: true, sshPublicKey: true },
    });
    if (cs?.ip) {
      sshOpts = { host: cs.ip, username: 'root', privateKey: cs.sshPublicKey ?? undefined };
    }
  }

  for (const step of steps) {
    checkCancelled(ctx);
    emitLog(ctx, step.name, `▶ ${step.name}`, 'info');

    if (step.type === 'LOCAL_COMMAND') {
      await runCommand('sh', ['-c', step.command], process.cwd(),
        (line) => emitLog(ctx, step.name, line));
    } else if (step.type === 'REMOTE_SSH_COMMAND') {
      if (!sshOpts) {
        throw new Error(`Step "${step.name}" requer SSH mas não há servidor cloud configurado.`);
      }
      await executeSSHCommand(sshOpts, step.command, (line) => emitLog(ctx, step.name, line));
    }

    emitLog(ctx, step.name, `✓ ${step.name} concluído`, 'success');
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runPipeline(ctx: PipelineContext): Promise<void> {
  ctx._logs = [];

  try {
    emitStatus(ctx, 'RUNNING');

    const stepCount = await prisma.workflowStep.count({ where: { projectId: ctx.projectId } });

    let testsPassed: number | undefined;
    let testsTotal: number | undefined;

    if (stepCount > 0) {
      await runWorkflowSteps(ctx);
    } else if (ctx.environmentType === 'CLOUD' || ctx.environmentType === 'NODE') {
      await runRemotePipeline(ctx);
    } else {
      const results = await runAutomaticDockerPipeline(ctx);
      testsPassed = results.testsPassed;
      testsTotal  = results.testsTotal;
    }

    await finalize(ctx, 'SUCCESS', undefined, testsPassed, testsTotal);
  } catch (err: any) {
    const isCancelled  = err.message?.includes('cancelado');
    const isRolledBack = err instanceof RolledBackError;
    const status = isCancelled ? 'CANCELLED' : isRolledBack ? 'ROLLED_BACK' : 'FAILED';
    await finalize(ctx, status, err.message);
  }
}
