import { Router } from 'express';
import {
  analyze,
  apply,
  createGroup,
  deleteGroup,
  getGroup,
  getRun,
  introspectTable,
  introspectTables,
  listGroups,
  listRuns,
  updateGroup,
} from '../controllers/configReplicate.controller';
import { isAuthenticated, requireRoles } from '../middleware/auth.middleware';
import {
  validate,
  configReplicateAnalyzeSchema,
  configReplicateApplySchema,
  configReplicateGroupSchema,
  configReplicateIntrospectTableSchema,
  configReplicateIntrospectTablesSchema,
} from '../middleware/validation.middleware';
import { Role } from '../constants/roles';

const router = Router();

router.use(isAuthenticated);

// Applied to the read-only endpoints too: introspection otherwise hands a full
// schema map of every connected database to any authenticated role.
const requireConfigReplicate = requireRoles(Role.MASTER, Role.ADMIN);

router.get('/groups', requireConfigReplicate, listGroups);
router.get('/groups/:id', requireConfigReplicate, getGroup);
router.post('/groups', requireConfigReplicate, validate(configReplicateGroupSchema), createGroup);
router.put('/groups/:id', requireConfigReplicate, validate(configReplicateGroupSchema), updateGroup);
router.delete('/groups/:id', requireConfigReplicate, deleteGroup);

router.post(
  '/introspect/tables',
  requireConfigReplicate,
  validate(configReplicateIntrospectTablesSchema),
  introspectTables
);
router.post(
  '/introspect/table',
  requireConfigReplicate,
  validate(configReplicateIntrospectTableSchema),
  introspectTable
);

router.post('/analyze', requireConfigReplicate, validate(configReplicateAnalyzeSchema), analyze);
router.post('/apply', requireConfigReplicate, validate(configReplicateApplySchema), apply);

router.get('/runs', requireConfigReplicate, listRuns);
router.get('/runs/:id', requireConfigReplicate, getRun);

export default router;
