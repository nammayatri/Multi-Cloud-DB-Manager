import { Router } from 'express';
import { executeRedisCommand, scanKeys, getScanStatus, cancelScan, getRedisHistory, getRedisConfiguration } from '../controllers/redis.controller';
import { isAuthenticated, validateRedisPermissions, requireRoles } from '../middleware/auth.middleware';
import { validate, redisCommandSchema, redisScanSchema } from '../middleware/validation.middleware';
import { Role } from '../constants/roles';

const router = Router();

// All routes require authentication
router.use(isAuthenticated);

// Anyone with Redis access. CKH_MANAGER and REQUESTOR are denied (no Redis
// access by spec). This allowlist guards every route including /execute and
// /scan: validateRedisPermissions narrows what an allowed role may run, but it
// branches per role and so falls *open* for a role it doesn't know about —
// the gate that fails closed has to be this one.
const requireRedisAccess = requireRoles(Role.MASTER, Role.ADMIN, Role.USER, Role.READER, Role.RELEASE_MANAGER, Role.CACHE_CLEARER);

// Execute a Redis command
router.post('/execute', requireRedisAccess, validate(redisCommandSchema), validateRedisPermissions, executeRedisCommand);

// Start a SCAN operation
router.post('/scan', requireRedisAccess, validate(redisScanSchema), validateRedisPermissions, scanKeys);

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
