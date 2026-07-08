import { Router } from 'express';
import {
    getStatus,
    manualSync,
    executeQuery,
    listSyncableTables,
    checkTableSync,
    syncTableColumns,
    createTable,
    startBackfill,
    getBackfillStatus,
    cancelBackfill,
} from '../controllers/clickhouse.controller';
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

// GET /api/clickhouse/tables — list PG tables (no CH check — see /check-table)
router.get('/tables', isAuthenticated, requireChWriter, listSyncableTables);

// POST /api/clickhouse/check-table — on-demand column-name diff for a single table
router.post('/check-table', isAuthenticated, requireChWriter, checkTableSync);

// POST /api/clickhouse/sync-columns — sync missing columns for an existing CH table
router.post('/sync-columns', isAuthenticated, requireChWriter, syncTableColumns);

// POST /api/clickhouse/create-table — create a new CH table from PG schema
router.post('/create-table', isAuthenticated, requireChWriter, createTable);

// POST /api/clickhouse/backfill — start an async data backfill job
router.post('/backfill', isAuthenticated, requireChWriter, startBackfill);

// GET /api/clickhouse/backfill/:id — poll backfill job status
router.get('/backfill/:id', isAuthenticated, requireChWriter, getBackfillStatus);

// POST /api/clickhouse/backfill/:id/cancel — cancel a running backfill
router.post('/backfill/:id/cancel', isAuthenticated, requireChWriter, cancelBackfill);

export default router;
