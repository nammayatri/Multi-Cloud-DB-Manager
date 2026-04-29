import { Router } from 'express';
import { executeRedisCommand, scanKeys, getScanStatus, cancelScan, getRedisHistory, getRedisConfiguration } from '../controllers/redis.controller';
import { isAuthenticated, validateRedisPermissions, requireRoles } from '../middleware/auth.middleware';
import { validate, redisCommandSchema, redisScanSchema } from '../middleware/validation.middleware';
import { Role } from '../constants/roles';

const router = Router();

// All routes require authentication
router.use(isAuthenticated);

// Anyone with Redis access. CKH_MANAGER is denied (no Redis access by spec).
const requireRedisAccess = requireRoles(Role.MASTER, Role.USER, Role.READER, Role.RELEASE_MANAGER);

// Execute a Redis command
router.post('/execute', validate(redisCommandSchema), validateRedisPermissions, executeRedisCommand);

// Start a SCAN operation
router.post('/scan', validate(redisScanSchema), validateRedisPermissions, scanKeys);

// Cancel a running SCAN
router.post('/scan/:id/cancel', requireRedisAccess, cancelScan);

// Get SCAN status
router.get('/scan/:id', requireRedisAccess, getScanStatus);

// Get Redis operation history (write commands + SCAN deletes)
router.get('/history', requireRedisAccess, getRedisHistory);

// Get Redis services + clouds for the UI to render selectors.
// All Redis-access roles can read — same gating as listing/scanning.
router.get('/configuration', requireRedisAccess, getRedisConfiguration);

export default router;
