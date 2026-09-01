import { Router } from 'express';
import { getLeanFlowFeatures, listConfigs, updateConfig } from '../controllers/systemConfigs.controller';
import { isAuthenticated, requireRoles } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import { z } from 'zod';
import { Role } from '../constants/roles';

const router = Router();

router.use(isAuthenticated);

// Reads: standard Postgres-access roles, same tier as DB Manager / Migrations.
const READ_ROLES: Role[] = [Role.MASTER, Role.ADMIN, Role.USER, Role.READER, Role.RELEASE_MANAGER];

// Writes: MASTER + ADMIN only — this toggles production feature flags
// (lean_flow, kv_configs, ...) fleet-wide, not a single row of app data.
const WRITE_ROLES: Role[] = [Role.MASTER, Role.ADMIN];

const updateConfigSchema = z.object({
  database: z.string().min(1, 'database is required'),
  cloud: z.string().min(1, 'cloud is required'),
  pgSchema: z.string().min(1, 'pgSchema is required'),
  id: z.string().min(1, 'id is required'),
  configValue: z.string().min(1, 'configValue is required'),
});

router.get('/lean-flow-features', requireRoles(...READ_ROLES), getLeanFlowFeatures);
router.get('/list', requireRoles(...READ_ROLES), listConfigs);
router.post('/update', requireRoles(...WRITE_ROLES), validate(updateConfigSchema), updateConfig);

export default router;
