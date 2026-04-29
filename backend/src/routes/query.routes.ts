import { Router } from 'express';
import { executeQuery, validateQuery, cancelQuery, getActiveExecutions, getExecutionStatus } from '../controllers/query.controller';
import { startCsvBatch, getCsvBatchStatus, cancelCsvBatch } from '../controllers/csvBatch.controller';
import { isAuthenticated, validateQueryPermissions, requireRoles } from '../middleware/auth.middleware';
import { validate, queryExecutionSchema, csvBatchSchema } from '../middleware/validation.middleware';
import { Role } from '../constants/roles';

const router = Router();

// All routes require authentication
router.use(isAuthenticated);

// CSV-batch runs arbitrary parameterized SQL via `queryTemplate`, so it bypasses
// validateQueryPermissions (which inspects req.body.query). Gate it explicitly.
// MASTER + USER are the only roles that may modify Postgres; CKH_MANAGER,
// RELEASE_MANAGER, and READER are denied, matching the /execute write-permission semantics.
const requireBatchWriter = requireRoles(Role.MASTER, Role.USER);

// Execute query (with role-based permissions check) - returns executionId immediately
router.post('/execute', validate(queryExecutionSchema), validateQueryPermissions, executeQuery);

// Get execution status and results (for polling)
router.get('/status/:executionId', isAuthenticated, getExecutionStatus);

// Cancel an active query execution
router.post('/cancel/:executionId', isAuthenticated, cancelQuery);

// Get list of active query executions
router.get('/active', isAuthenticated, getActiveExecutions);

// Validate query without executing
router.post('/validate', validateQuery);

// CSV-driven batch query execution
router.post('/csv-batch', requireBatchWriter, validate(csvBatchSchema), startCsvBatch);
router.get('/csv-batch/status/:executionId', requireBatchWriter, getCsvBatchStatus);
router.post('/csv-batch/cancel/:executionId', requireBatchWriter, cancelCsvBatch);

export default router;
