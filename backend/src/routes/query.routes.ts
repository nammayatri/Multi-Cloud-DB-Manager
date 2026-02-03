import { Router } from 'express';
import { executeQuery, validateQuery } from '../controllers/query.controller';
import { isAuthenticated, validateQueryPermissions } from '../middleware/auth.middleware';
import { validate, queryExecutionSchema } from '../middleware/validation.middleware';

const router = Router();

// All routes require authentication
router.use(isAuthenticated);

// Execute query (with role-based permissions check)
router.post('/execute', validate(queryExecutionSchema), validateQueryPermissions, executeQuery);

// Validate query without executing
router.post('/validate', validateQuery);

export default router;
