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
router.post( '/nodes/:id/benchmark',    ...guard, ctrl.runBenchmark);
router.post( '/nodes/:id/infra-type',   ...guard, ctrl.setInfraType);
router.post( '/stress-test',            ...guard, ctrl.globalStressTest);

// Sprint 17.3 — Backend log stream (recent errors)
router.get(  '/logs',                   ...guard, ctrl.getRecentLogs);

export default router;
