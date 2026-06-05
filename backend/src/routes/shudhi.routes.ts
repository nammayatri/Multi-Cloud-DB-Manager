import { Router } from 'express';
import { getShudhiStatus, getServices, getPods, getKeys, getValue, refreshCache } from '../controllers/shudhi.controller';
import { isAuthenticated, requireRoles } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import { z } from 'zod';
import { Role } from '../constants/roles';

const router = Router();

router.use(isAuthenticated);

// All roles except CKH_MANAGER can access Shudhi
const requireShudhiAccess = requireRoles(Role.MASTER, Role.ADMIN, Role.USER, Role.READER, Role.RELEASE_MANAGER);

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

// Refresh (invalidate) cache — write operation, READER excluded
router.post('/refresh', requireRoles(Role.MASTER, Role.ADMIN, Role.USER, Role.RELEASE_MANAGER), validate(shudhiRefreshSchema), refreshCache);

export default router;
