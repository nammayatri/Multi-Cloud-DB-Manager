import { Router } from 'express';
import { executeRedisCommand, scanKeys, getScanStatus, cancelScan, getRedisHistory } from '../controllers/redis.controller';
import { isAuthenticated, validateRedisPermissions } from '../middleware/auth.middleware';
import { validate, redisCommandSchema, redisScanSchema } from '../middleware/validation.middleware';

const router = Router();

// All routes require authentication
router.use(isAuthenticated);

// Execute a Redis command
router.post('/execute', validate(redisCommandSchema), validateRedisPermissions, executeRedisCommand);

// Start a SCAN operation
router.post('/scan', validate(redisScanSchema), validateRedisPermissions, scanKeys);

// Cancel a running SCAN
router.post('/scan/:id/cancel', cancelScan);

// Get SCAN status
router.get('/scan/:id', getScanStatus);

// Get Redis operation history (write commands + SCAN deletes)
router.get('/history', getRedisHistory);

export default router;
