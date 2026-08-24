import { Router } from 'express';
import { getShudhiStatus, getServices, getPods, getKeys, getValue, refreshCache } from '../controllers/shudhi.controller';
import { isAuthenticated, requireRoles } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import { z } from 'zod';
import { Role, CACHE_CLEAR_ROLES } from '../constants/roles';

const router = Router();

router.use(isAuthenticated);

// All roles except CKH_MANAGER can access Shudhi
const requireShudhiAccess = requireRoles(Role.MASTER, Role.ADMIN, Role.USER, Role.READER, Role.RELEASE_MANAGER, Role.CACHE_CLEARER);

// Validation schemas — match Shudhi's Go structs
const shudhiGetSchema = z.object({
  serviceName: z.string().min(1, 'serviceName is required'),
  podName: z.string().min(1, 'podName is required'),
  key: z.string().min(1, 'key is required'),
});

const shudhiRefreshSchema = z.object({
  serviceName: z.string().min(1, 'serviceName is required'),
  keyInfix: z.string().optional(),
});

// Status / health
router.get('/status', requireShudhiAccess, getShudhiStatus);

// List registered services
router.get('/services', requireShudhiAccess, getServices);

// List pods for a service
router.get('/pods', requireShudhiAccess, getPods);

// List registered cache keys
router.get('/keys', requireShudhiAccess, getKeys);

// Get cached value from a specific pod
router.post('/get', requireShudhiAccess, validate(shudhiGetSchema), getValue);

// Refresh (invalidate) cache — write operation. READER excluded; CACHE_CLEARER
// is included since invalidation is exactly what that role exists for.
router.post('/refresh', requireRoles(...CACHE_CLEAR_ROLES), validate(shudhiRefreshSchema), refreshCache);

export default router;
