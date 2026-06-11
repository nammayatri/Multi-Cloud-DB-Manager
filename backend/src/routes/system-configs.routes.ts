import { Router } from 'express';
import { getTargets, getKeys, getConfig, validateConfigValue, executeUpdate } from '../controllers/system-configs.controller';
import { isAuthenticated, requireRoles } from '../middleware/auth.middleware';
import { validate, systemConfigValidateSchema, systemConfigExecuteSchema } from '../middleware/validation.middleware';
import { Role } from '../constants/roles';

const router = Router();

// All routes require authentication
router.use(isAuthenticated);

// System Configs writes hit production via the NY dashboard — MASTER/ADMIN only,
// including the read endpoints (the config values themselves are sensitive).
const requireSystemConfigsAccess = requireRoles(Role.MASTER, Role.ADMIN);

// Configured targets for the UI selector (reports configured:false, never 503)
router.get('/targets', requireSystemConfigsAccess, getTargets);

// List config ids for a target (optional substring search)
router.get('/keys', requireSystemConfigsAccess, getKeys);

// Fetch one config row's raw value
router.get('/config', requireSystemConfigsAccess, getConfig);

// Validate a config value against the Tables type (no side effects)
router.post('/validate', requireSystemConfigsAccess, validate(systemConfigValidateSchema), validateConfigValue);

// Execute an UPDATE through the dashboard (bcrypt password re-verified in controller)
router.post('/execute', requireSystemConfigsAccess, validate(systemConfigExecuteSchema), executeUpdate);

export default router;
