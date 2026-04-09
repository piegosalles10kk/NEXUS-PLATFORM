/**
 * workload-dispatch.service.ts
 *
 * Sends workload commands to agents via the existing WebSocket tunnel.
 *
 * Supported actions:
 *  - run_wasm   → agent executes a .wasm module via wasmtime
 *  - start_vm   → agent provisions a Firecracker MicroVM
 *  - stop_wasm  → agent stops a WASM worker
 *  - stop_vm    → agent stops/destroys a MicroVM
 */
import { WebSocket } from 'ws';
import { getAgentSocket } from './agent-ws.service';
import type { NodeCandidate } from './scheduler.service';

// The DePINApp shape we receive (minimal — only fields we need)
interface AppPayload {
  id: string;
  slug: string;
  executionMode: string;
  imageRef: string | null;
  envVars: Record<string, string> | null | any;
  port: number | null;
  assignments?: Array<{ nodeId: string; role: string }>;
}

function sendToAgent(ws: WebSocket, payload: object): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

// ── WASM dispatch ─────────────────────────────────────────────────────────────

function dispatchWasm(nodeId: string, app: AppPayload): void {
  const ws = getAgentSocket(nodeId);
  if (!ws) {
    console.warn(`[dispatch] WASM: agent ${nodeId} not connected — skipping`);
    return;
  }

  sendToAgent(ws, {
    type:      'run_wasm',
    action:    'run_wasm',
    appId:     app.id,
    appSlug:   app.slug,
    moduleRef: app.imageRef ?? '',      // path or base64 of .wasm module
    envVars:   app.envVars ?? {},
  });

  console.log(`[dispatch] WASM sent to node ${nodeId} for app ${app.slug}`);
}

// ── MicroVM dispatch ──────────────────────────────────────────────────────────

function dispatchMicroVM(
  nodeId: string,
  app: AppPayload,
  role: 'LEADER' | 'FOLLOWER',
  peerAddresses: string[],
): void {
  const ws = getAgentSocket(nodeId);
  if (!ws) {
    console.warn(`[dispatch] VM: agent ${nodeId} not connected — skipping`);
    return;
  }

  sendToAgent(ws, {
    type:          'start_vm',
    action:        'start_vm',
    appId:         app.id,
    appSlug:       app.slug,
    image:         app.imageRef ?? 'ubuntu:22.04',
    port:          app.port ?? 8080,
    envVars:       app.envVars ?? {},
    // Raft clustering info
    raftRole:      role,
    raftPeers:     peerAddresses,
  });

  console.log(`[dispatch] MicroVM (${role}) sent to node ${nodeId} for app ${app.slug}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Dispatches workload start commands to the selected nodes.
 * For MICROVM: first node is LEADER, the rest are FOLLOWERs.
 */
export async function sendWorkloadToNodes(
  app: AppPayload,
  nodes: NodeCandidate[],
): Promise<void> {
  if (app.executionMode === 'WASM') {
    for (const node of nodes) {
      dispatchWasm(node.id, app);
    }
    return;
  }

  // MICROVM — build peer address list (node IPs) for Raft
  const peerAddresses = nodes
    .map((n) => n.ipAddress)
    .filter(Boolean) as string[];

  for (let i = 0; i < nodes.length; i++) {
    const role = i === 0 ? 'LEADER' : 'FOLLOWER';
    const peers = peerAddresses.filter((_, j) => j !== i); // exclude self
    dispatchMicroVM(nodes[i].id, app, role as 'LEADER' | 'FOLLOWER', peers);
  }
}

// ── Collective workload dispatch (Sprint 13) ──────────────────────────────────

export interface CollectiveNodeTarget {
  nodeId:        string;
  meshIp:        string;
  role:          'LEADER' | 'WORKER';
  rank:          number;
  cpuMillicores: number;
  memLimitMb:    number;
  vramLimitMb:   number;
  masterMeshIp:  string;
  worldSize:     number;
  peers:         { meshIp: string; rank: number }[];
}

/**
 * Dispatches `start_collective_vm` commands to each node in a ResourceCluster.
 * Each node receives its exact hardware budget (cpuMillicores, memLimitMb,
 * vramLimitMb) and the full NCCL/Ray/DeepSpeed env vars when appType === "AI".
 */
export async function dispatchCollectiveWorkload(
  app: AppPayload,
  allocations: CollectiveNodeTarget[],
  appType = '',
): Promise<void> {
  for (const alloc of allocations) {
    const ws = getAgentSocket(alloc.nodeId);
    if (!ws) {
      console.warn(`[dispatch] Collective: agent ${alloc.nodeId} not connected — skipping rank ${alloc.rank}`);
      continue;
    }

    sendToAgent(ws, {
      type:               'start_collective_vm',
      action:             'start_collective_vm',
      appId:              app.id,
      appSlug:            app.slug,
      image:              app.imageRef ?? 'ubuntu:22.04',
      port:               app.port ?? 8080,
      envVars:            app.envVars ?? {},
      isCollectiveMember: true,
      cpuMillicores:      alloc.cpuMillicores,
      memLimitMb:         alloc.memLimitMb,
      vramLimitMb:        alloc.vramLimitMb,
      meshIp:             alloc.meshIp,
      masterMeshIp:       alloc.masterMeshIp,
      rank:               alloc.rank,
      worldSize:          alloc.worldSize,
      collectivePeers:    alloc.peers,
      appType,
    });

    console.log(
      `[dispatch] Collective VM rank=${alloc.rank}/${alloc.worldSize - 1} → node ${alloc.nodeId}` +
      ` (${alloc.cpuMillicores}m CPU, ${alloc.memLimitMb}MB RAM, ${alloc.vramLimitMb}MB VRAM)`,
    );
  }
}

/**
 * Sends stop commands to all nodes currently assigned to an app.
 */
export async function sendStopToNodes(app: AppPayload): Promise<void> {
  const assignments = app.assignments ?? [];

  for (const assignment of assignments) {
    const ws = getAgentSocket(assignment.nodeId);
    if (!ws) continue;

    if (app.executionMode === 'WASM') {
      sendToAgent(ws, { type: 'stop_wasm', action: 'stop_wasm', appId: app.id, appSlug: app.slug });
    } else {
      sendToAgent(ws, { type: 'stop_vm',   action: 'stop_vm',   appId: app.id, appSlug: app.slug });
    }

    console.log(`[dispatch] Stop sent to node ${assignment.nodeId} for app ${app.slug}`);
  }
}
