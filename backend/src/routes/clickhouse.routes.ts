import { Router } from 'express';
import { getStatus, manualSync, executeQuery } from '../controllers/clickhouse.controller';
import { isAuthenticated, requireRoles } from '../middleware/auth.middleware';
import { validate, clickhouseQuerySchema } from '../middleware/validation.middleware';
import { Role } from '../constants/roles';

const router = Router();
const requireChWriter = requireRoles(Role.MASTER, Role.ADMIN, Role.CKH_MANAGER);

// GET /api/clickhouse/status — any authenticated user can check health
router.get('/status', isAuthenticated, getStatus);

// POST /api/clickhouse/sync — MASTER + CKH_MANAGER (manual backfill trigger)
router.post('/sync', isAuthenticated, requireChWriter, manualSync);

// POST /api/clickhouse/query — MASTER + CKH_MANAGER (ad-hoc query execution)
router.post('/query', isAuthenticated, requireChWriter, validate(clickhouseQuerySchema), executeQuery);

export default router;
