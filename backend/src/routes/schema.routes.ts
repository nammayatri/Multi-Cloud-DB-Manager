import { Router } from 'express';
import { getSchemas, getConfiguration } from '../controllers/schema.controller';
import { isAuthenticated } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(isAuthenticated);

// Get full database configuration
router.get('/configuration', getConfiguration);

// Get schemas for a database (backward compatibility)
router.get('/:database', getSchemas);

export default router;
