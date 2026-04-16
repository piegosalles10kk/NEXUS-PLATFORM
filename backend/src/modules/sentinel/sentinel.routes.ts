import { Router } from 'express';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';
import * as ctrl from './sentinel.controller';

const router = Router();

// All Sentinel routes require ADM
const guard = [authenticate, authorize('ADM')];

// Tenant governance
router.get( '/tenants',          ...guard, ctrl.listTenants);
router.post('/tenants',          ...guard, ctrl.createTenant);
router.post('/tenants/:id/ban',  ...guard, ctrl.banTenant);
router.post('/tenants/:id/unban',...guard, ctrl.unbanTenant);

// LGPD soft-delete
router.delete('/users/:id',      ...guard, ctrl.softDeleteUser);

// Credit injection
router.post('/ledger/mint',      ...guard, ctrl.mintCredits);

// M.A.D. emergency halt
router.post('/emergency-halt',   ...guard, ctrl.emergencyHalt);

// Audit trail
router.get( '/audit',            ...guard, ctrl.getAuditLogs);

// Sprint 17 — Benchmark & Stress Test
router.get(  '/nodes/benchmarks',       ...guard, ctrl.listBenchmarks);
router.get(  '/nodes/peer-matrix',      ...guard, ctrl.getPeerMatrix);
router.post( '/nodes/:id/benchmark',    ...guard, ctrl.runBenchmark);
router.post( '/nodes/:id/infra-type',   ...guard, ctrl.setInfraType);
router.post( '/stress-test',            ...guard, ctrl.globalStressTest);

// Sprint 17.3 — Backend log stream (recent errors)
router.get(  '/logs',                   ...guard, ctrl.getRecentLogs);

// Invite codes
router.get(   '/invite-codes',          ...guard, ctrl.listInviteCodes);
router.post(  '/invite-codes',          ...guard, ctrl.createInviteCode);
router.delete('/invite-codes/:id',      ...guard, ctrl.revokeInviteCode);

// Tenant suspend (distinct from ban)
router.post('/tenants/:id/suspend',     ...guard, ctrl.suspendTenant);

// Mesh connectivity test (ping all online nodes)
router.post('/mesh-test',               ...guard, ctrl.meshConnectivityTest);

// Sprint 18.1 — RMM / EDR
router.get( '/rmm/nodes/:id/processes',         ...guard, ctrl.rmmListProcesses);
router.delete('/rmm/nodes/:id/processes/:pid',  ...guard, ctrl.rmmKillProcess);
router.get( '/rmm/nodes/:id/connections',       ...guard, ctrl.rmmScanConnections);

// Sprint 18.3 — Dual-Mesh provisioning
router.post('/nodes/:id/dual-mesh',             ...guard, ctrl.setupDualMesh);

// Sprint 20.3 — Live Migration (CRIU)
router.post('/migrate',                         ...guard, ctrl.liveMigrate);

// Sprint 21.2 — Federated Learning: gradient ingestion + model broadcast
router.post('/ml/gradients',                    authenticate, ctrl.ingestGradient); // agents call this (no ADM required)
router.get( '/ml/model',                        authenticate, ctrl.getGlobalModel); // agents pull the model
router.post('/ml/aggregate',                    ...guard, ctrl.triggerFedAvg);      // ADM triggers manual aggregation

export default router;
