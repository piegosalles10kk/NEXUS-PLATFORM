import Docker from 'dockerode';
import { Writable } from 'stream';

// Prefer DOCKER_PROXY_HOST (TCP via docker-socket-proxy) over raw socket
function createDockerClient(): Docker {
  const proxyHost = process.env.DOCKER_PROXY_HOST;
  if (proxyHost) {
    try {
      const url = new URL(proxyHost);
      return new Docker({ host: url.hostname, port: parseInt(url.port || '2375', 10) });
    } catch {
      console.warn(`⚠️  Invalid DOCKER_PROXY_HOST: ${proxyHost}, falling back to socket`);
    }
  }
  const socketPath = process.platform === 'win32'
    ? '//./pipe/docker_engine'
    : '/var/run/docker.sock';
  return new Docker({ socketPath });
}

const docker = createDockerClient();

export interface BuildImageOptions {
  context: string;
  tag: string;
  dockerfile?: string;
  onLog?: (log: string) => void;
}

export interface ContainerOptions {
  name: string;
  image: string;
  ports?: Record<string, string>;
  env?: string[];
  network?: string;
  labels?: Record<string, string>;
}

export async function checkDockerConnection(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch (error) {
    console.warn('⚠️  Docker not available:', (error as Error).message);
    return false;
  }
}

export async function buildImage(options: BuildImageOptions): Promise<string> {
  const { context, tag, dockerfile = 'Dockerfile', onLog } = options;

  const stream = await docker.buildImage(
    { context, src: ['.'] },
    {
      t: tag,
      dockerfile,
    }
  );

  return new Promise((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null, output: any[]) => {
        if (err) {
          reject(err);
        } else {
          resolve(tag);
        }
      },
      (event: any) => {
        if (event.stream && onLog) {
          onLog(event.stream.trim());
        }
        if (event.error) {
          if (onLog) onLog(`ERROR: ${event.error}`);
        }
      }
    );
  });
}

export async function createAndStartContainer(options: ContainerOptions): Promise<Docker.Container> {
  const { name, image, ports = {}, env = [], network, labels = {} } = options;

  // Build port bindings
  const exposedPorts: Record<string, {}> = {};
  const portBindings: Record<string, { HostPort: string }[]> = {};

  for (const [containerPort, hostPort] of Object.entries(ports)) {
    const portKey = `${containerPort}/tcp`;
    exposedPorts[portKey] = {};
    portBindings[portKey] = [{ HostPort: hostPort }];
  }

  const container = await docker.createContainer({
    Image: image,
    name,
    Env: env,
    Labels: labels,
    ExposedPorts: exposedPorts,
    HostConfig: {
      PortBindings: portBindings,
      ...(network && { NetworkMode: network }),
    },
  });

  await container.start();
  return container;
}

/** Returns true if an image with the given name[:tag] exists locally. */
export async function imageExists(name: string): Promise<boolean> {
  try {
    await docker.getImage(name).inspect();
    return true;
  } catch {
    return false;
  }
}

/**
 * Tags an existing image with a new repo:tag.
 * Equivalent to: docker tag <source> <repo>:<tag>
 */
export async function tagImage(source: string, repo: string, tag: string): Promise<void> {
  await docker.getImage(source).tag({ repo, tag });
}

export async function stopAndRemoveContainer(containerName: string): Promise<void> {
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();

    if (info.State.Running) {
      await container.stop({ t: 10 });
    }

    await container.remove({ force: true });
  } catch (error: any) {
    if (error.statusCode === 404) {
      // Container doesn't exist, nothing to do
      return;
    }
    throw error;
  }
}

export async function getContainerLogs(
  containerName: string,
  onLog: (log: string) => void
): Promise<any> {
  const container = docker.getContainer(containerName);

  const logStream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: true,
  });

  const writeStream = new Writable({
    write(chunk, _encoding, callback) {
      onLog(chunk.toString('utf8'));
      callback();
    },
  });

  docker.modem.demuxStream(logStream, writeStream, writeStream);
  return logStream;
}

export async function listContainers(): Promise<Docker.ContainerInfo[]> {
  return docker.listContainers({ all: true });
}

export async function getContainerStats(
  containerName: string,
): Promise<{ cpuPercent: number; memPercent: number } | null> {
  try {
    const container = docker.getContainer(containerName);
    const stats: any = await new Promise((resolve, reject) => {
      container.stats({ stream: false }, (err: Error | null, data: any) => {
        if (err) reject(err);
        else resolve(data);
      });
    });

    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage -
      stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta =
      stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuCount =
      stats.cpu_stats.online_cpus ||
      stats.cpu_stats.cpu_usage.percpu_usage?.length ||
      1;
    const cpuPercent =
      systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;

    const memUsed =
      stats.memory_stats.usage - (stats.memory_stats.stats?.cache ?? 0);
    const memPercent =
      stats.memory_stats.limit > 0
        ? (memUsed / stats.memory_stats.limit) * 100
        : 0;

    return {
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memPercent: Math.round(memPercent * 10) / 10,
    };
  } catch {
    return null;
  }
}

export async function ensureLbNetwork(): Promise<void> {
  try {
    const networks = await docker.listNetworks();
    const exists = networks.some((n: any) => n.Name === 'cicd-lb-net');
    if (!exists) {
      await docker.createNetwork({ Name: 'cicd-lb-net', Driver: 'bridge' });
      console.log('✅ Created Docker network: cicd-lb-net');
    }
  } catch (error) {
    console.warn('⚠️  Could not ensure lb network:', (error as Error).message);
  }
}

export async function connectContainerToLbNetwork(containerId: string): Promise<void> {
  const network = docker.getNetwork('cicd-lb-net');
  await network.connect({ Container: containerId });
}

/** Run a command inside a running container and return its stdout+stderr. */
export async function execInContainer(containerName: string, cmd: string[]): Promise<string> {
  const container = docker.getContainer(containerName);
  const execInstance = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });

  return new Promise((resolve, reject) => {
    execInstance.start({ hijack: true, stdin: false }, (err: Error | null, stream: any) => {
      if (err) return reject(err);
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        // Docker multiplexed stream: 8-byte header (type + size) followed by payload
        const buffer = Buffer.concat(chunks);
        let output = '';
        let offset = 0;
        while (offset + 8 <= buffer.length) {
          const size = buffer.readUInt32BE(offset + 4);
          output += buffer.slice(offset + 8, offset + 8 + size).toString();
          offset += 8 + size;
        }
        resolve(output.trim());
      });
      stream.on('error', reject);
    });
  });
}

/** Build nginx upstream config for a project's containers. */
function buildNginxConfig(imageTag: string, upstreamNames: string[], appPort: number): string {
  const servers = upstreamNames.map((name) => `    server ${name}:${appPort};`).join('\n');
  return `upstream ${imageTag}_backend {
    least_conn;
${servers}
}

server {
    listen 80;
    location / {
        proxy_pass http://${imageTag}_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }
}`;
}

/**
 * Start a dedicated nginx load-balancer container for a project.
 * Exposes lbPort on the host, proxying to app containers on cicd-lb-net.
 */
export async function startNginxLb(imageTag: string, lbPort: number): Promise<Docker.Container> {
  const lbName = `${imageTag}-lb`;
  // Remove any stale LB container first
  await stopAndRemoveContainer(lbName).catch(() => {});

  const container = await docker.createContainer({
    name: lbName,
    Image: 'nginx:alpine',
    ExposedPorts: { '80/tcp': {} },
    HostConfig: {
      PortBindings: { '80/tcp': [{ HostPort: String(lbPort) }] },
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
    },
  });
  await container.start();
  // Wait for nginx process to initialize before writing config
  await new Promise((r) => setTimeout(r, 1500));
  return container;
}

/**
 * Write nginx upstream config into a running LB container and reload nginx.
 * Safe to call on every scale-out or scale-in.
 */
export async function updateNginxConfig(
  imageTag: string,
  upstreamNames: string[],
  appPort: number,
): Promise<void> {
  const lbName = `${imageTag}-lb`;
  const config = buildNginxConfig(imageTag, upstreamNames, appPort);
  // Encode as base64 to avoid shell-escaping issues with special characters
  const b64 = Buffer.from(config).toString('base64');

  await execInContainer(lbName, [
    'sh', '-c',
    `echo ${b64} | base64 -d > /etc/nginx/conf.d/default.conf`,
  ]);
  await execInContainer(lbName, ['nginx', '-s', 'reload']);
}

/** Subscribe to Docker engine events. Calls onEvent for each JSON event received. */
export function startDockerEventStream(onEvent: (event: any) => void): void {
  docker.getEvents({}, (err: Error | null, stream: any) => {
    if (err || !stream) {
      console.warn('⚠️  Could not start Docker events stream:', err?.message);
      return;
    }
    stream.on('data', (chunk: Buffer) => {
      try {
        const event = JSON.parse(chunk.toString());
        onEvent(event);
      } catch { /* ignore malformed frames */ }
    });
    stream.on('error', (e: Error) => {
      console.warn('Docker events stream error:', e.message);
    });
    console.log('👁️  Docker events stream connected');
  });
}

export default docker;
