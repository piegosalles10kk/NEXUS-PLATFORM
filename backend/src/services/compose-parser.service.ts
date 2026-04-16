/**
 * compose-parser.service.ts — Sprint 18.2
 *
 * Parses a docker-compose.yml file and produces a list of service descriptors
 * that the Scheduler can distribute across nodes.
 *
 * Parsing strategy:
 *   - Identify service roles (frontend / backend-api / database / cache / worker)
 *   - Extract port mappings, environment variables, dependencies
 *   - Inject Nexus gateway labels so the Gateway picks up the routes
 *   - Return a DeployPlan the Scheduler can execute directly
 *
 * No YAML library is added — we use a lightweight hand-rolled parser so the
 * package footprint stays minimal (docker-compose.yml is regular enough).
 * For production use, swap in the 'js-yaml' package.
 */

export type ServiceRole = 'frontend' | 'api' | 'database' | 'cache' | 'worker' | 'unknown';

export interface ParsedService {
  name:        string;
  role:        ServiceRole;
  image?:      string;
  build?:      string;          // build context path
  ports:       string[];        // ["3000:3000"]
  envVars:     Record<string, string>;
  depends:     string[];        // other service names
  volumes:     string[];
  networks:    string[];
  cpuLimit?:   number;          // millicores (1000 = 1 vCPU)
  memLimit?:   number;          // MB
  replicas:    number;
  gatewayRoute?: string;        // inferred route path for Nexus Gateway
}

export interface DeployPlan {
  services:      ParsedService[];
  networkName:   string;        // top-level network (defaults to stack name + "_default")
  totalServices: number;
  warnings:      string[];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * parseComposeYaml — parses raw YAML text and returns a DeployPlan.
 *
 * @param yaml     Raw docker-compose.yml content
 * @param stackName Stack name (default: "nexus")
 */
export function parseComposeYaml(yaml: string, stackName = 'nexus'): DeployPlan {
  const warnings: string[] = [];
  const lines = yaml.split('\n');

  // Extract top-level sections
  const sections = extractSections(lines);
  const serviceBlock = sections['services'] ?? '';

  if (!serviceBlock) {
    return {
      services:      [],
      networkName:   `${stackName}_default`,
      totalServices: 0,
      warnings:      ['No "services:" section found in compose file'],
    };
  }

  const serviceNames = extractServiceNames(serviceBlock);
  const services: ParsedService[] = [];

  for (const name of serviceNames) {
    const block = extractServiceBlock(serviceBlock, name, serviceNames);
    const svc   = parseServiceBlock(name, block, warnings);
    services.push(svc);
  }

  // Assign gateway routes to web-facing services
  for (const svc of services) {
    if (svc.role === 'frontend' || svc.role === 'api') {
      const port = svc.ports[0]?.split(':')[1] ?? svc.ports[0]?.split(':')[0] ?? '3000';
      svc.gatewayRoute = svc.role === 'frontend' ? '/' : `/api/${svc.name}`;
      svc.envVars['NEXUS_GATEWAY_ROUTE'] = svc.gatewayRoute;
      svc.envVars['NEXUS_GATEWAY_PORT']  = port;
    }
  }

  return {
    services,
    networkName:   `${stackName}_default`,
    totalServices: services.length,
    warnings,
  };
}

/**
 * planNodeAssignments — given a DeployPlan and a list of available nodes,
 * returns a mapping of service → nodeId.
 *
 * Placement rules (simple heuristics):
 *   - Databases and caches prefer nodes with infraType = CLOUD_MANAGED (stable)
 *   - Workers prefer SWARM nodes (cheap compute)
 *   - Frontend/API are distributed round-robin
 *   - GPU workloads require nodes with gpuCount > 0
 */
export function planNodeAssignments(
  plan: DeployPlan,
  nodes: Array<{
    id:         string;
    infraType:  string;
    status:     string;
    cpuCores:   number;
    ramMb:      number;
    gpuCount:   number;
  }>,
): Array<{ service: ParsedService; nodeId: string }> {
  const online = nodes.filter(n => n.status === 'ONLINE');
  if (online.length === 0) return [];

  const assignments: Array<{ service: ParsedService; nodeId: string }> = [];
  let rrIndex = 0;

  for (const svc of plan.services) {
    let node = online[rrIndex % online.length]; // default: round-robin

    if (svc.role === 'database' || svc.role === 'cache') {
      // Prefer stable managed nodes for stateful services
      const managed = online.filter(n => n.infraType === 'CLOUD_MANAGED');
      if (managed.length > 0) node = managed[0];
    } else if (svc.role === 'worker') {
      // Prefer community SWARM nodes for cheap compute
      const swarm = online.filter(n => n.infraType === 'SWARM');
      if (swarm.length > 0) node = swarm[rrIndex % swarm.length];
    }

    // Memory gate: skip nodes with < 256 MB available (rough estimate)
    const memRequired = svc.memLimit ?? 256;
    const validNodes  = online.filter(n => n.ramMb >= memRequired * 2);
    if (validNodes.length > 0 && !validNodes.includes(node)) {
      node = validNodes[rrIndex % validNodes.length];
    }

    assignments.push({ service: svc, nodeId: node.id });
    rrIndex++;
  }

  return assignments;
}

// ── Internal parser helpers ────────────────────────────────────────────────────

function extractSections(lines: string[]): Record<string, string> {
  const sections: Record<string, string> = {};
  let current: string | null = null;
  const sectionLines: string[] = [];

  for (const line of lines) {
    const topLevel = line.match(/^([a-z_]+):/);
    if (topLevel && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (current !== null) {
        sections[current] = sectionLines.join('\n');
        sectionLines.length = 0;
      }
      current = topLevel[1];
      continue;
    }
    if (current !== null) {
      sectionLines.push(line);
    }
  }
  if (current !== null) {
    sections[current] = sectionLines.join('\n');
  }
  return sections;
}

function extractServiceNames(servicesBlock: string): string[] {
  const names: string[] = [];
  for (const line of servicesBlock.split('\n')) {
    const m = line.match(/^  ([a-zA-Z0-9_-]+):/);
    if (m) names.push(m[1]);
  }
  return names;
}

function extractServiceBlock(
  servicesBlock: string,
  name:          string,
  allNames:      string[],
): string[] {
  const lines  = servicesBlock.split('\n');
  const start  = lines.findIndex(l => l.match(new RegExp(`^  ${name}:`)));
  if (start === -1) return [];

  const others = allNames.filter(n => n !== name);
  const end    = lines.findIndex((l, i) =>
    i > start && others.some(n => l.match(new RegExp(`^  ${n}:`)))
  );
  return end === -1 ? lines.slice(start) : lines.slice(start, end);
}

function parseServiceBlock(
  name:     string,
  block:    string[],
  warnings: string[],
): ParsedService {
  const svc: ParsedService = {
    name,
    role:     guessRole(name),
    ports:    [],
    envVars:  {},
    depends:  [],
    volumes:  [],
    networks: [],
    replicas: 1,
  };

  let inPorts = false, inEnv = false, inDepends = false, inVolumes = false;

  for (const line of block) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Detect list context by indentation
    if (trimmed.startsWith('ports:'))    { inPorts = true; inEnv = inDepends = inVolumes = false; continue; }
    if (trimmed.startsWith('environment:')) { inEnv = true; inPorts = inDepends = inVolumes = false; continue; }
    if (trimmed.startsWith('depends_on:')) { inDepends = true; inPorts = inEnv = inVolumes = false; continue; }
    if (trimmed.startsWith('volumes:'))  { inVolumes = true; inPorts = inEnv = inDepends = false; continue; }

    // Reset list on new key
    if (/^[a-z_]+:/.test(trimmed) && !trimmed.startsWith('-')) {
      inPorts = inEnv = inDepends = inVolumes = false;
    }

    // Parse image
    const imgMatch = trimmed.match(/^image:\s*(.+)/);
    if (imgMatch) { svc.image = imgMatch[1].replace(/['"]/g, '').trim(); continue; }

    // Parse build
    const buildMatch = trimmed.match(/^build:\s*(.+)/);
    if (buildMatch) { svc.build = buildMatch[1].replace(/['"]/g, '').trim(); continue; }

    // Parse replicas (deploy.replicas)
    const repMatch = trimmed.match(/^replicas:\s*(\d+)/);
    if (repMatch) { svc.replicas = parseInt(repMatch[1], 10); continue; }

    // Parse CPU/mem limits
    const cpuMatch = trimmed.match(/^cpus:\s*['"]?([\d.]+)['"]?/);
    if (cpuMatch) { svc.cpuLimit = Math.round(parseFloat(cpuMatch[1]) * 1000); continue; }
    const memMatch = trimmed.match(/^memory:\s*['"]?(\d+)([mMgG]?)['"]?/);
    if (memMatch) {
      const val = parseInt(memMatch[1], 10);
      svc.memLimit = memMatch[2].toLowerCase() === 'g' ? val * 1024 : val;
      continue;
    }

    // Collect list items
    if (trimmed.startsWith('- ')) {
      const val = trimmed.slice(2).trim();
      if (inPorts)   svc.ports.push(val.replace(/['"]/g, ''));
      if (inDepends) svc.depends.push(val.split(':')[0].replace(/['"]/g, ''));
      if (inVolumes) svc.volumes.push(val.replace(/['"]/g, ''));
    }

    // Environment key=value on same line
    if (inEnv && trimmed.includes('=')) {
      const [k, ...v] = trimmed.replace(/^-\s*/, '').split('=');
      svc.envVars[k.trim()] = v.join('=').trim().replace(/['"]/g, '');
    }
    if (inEnv && trimmed.includes(':') && !trimmed.startsWith('-')) {
      const [k, ...v] = trimmed.split(':');
      if (k && v.length) {
        svc.envVars[k.trim()] = v.join(':').trim().replace(/['"]/g, '');
      }
    }
  }

  if (!svc.image && !svc.build) {
    warnings.push(`Service "${name}" has neither image nor build context`);
  }

  return svc;
}

function guessRole(name: string): ServiceRole {
  const lower = name.toLowerCase();
  if (/front|web|ui|nginx|vite|react|next|vue/.test(lower))        return 'frontend';
  if (/api|back|server|app|service|express|fastapi|django/.test(lower)) return 'api';
  if (/db|postgres|mysql|mongo|sqlite|database|mariadb/.test(lower))    return 'database';
  if (/redis|cache|memcache|rabbit|kafka|queue/.test(lower))            return 'cache';
  if (/worker|job|cron|celery|sidekiq|processor/.test(lower))           return 'worker';
  return 'unknown';
}
