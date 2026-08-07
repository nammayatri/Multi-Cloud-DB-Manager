import { Router } from 'express';
import { addTables } from '../controllers/replication.controller';
import { isAuthenticated, requireRoles } from '../middleware/auth.middleware';
import { Role } from '../constants/roles';

const router = Router();

router.use(isAuthenticated);

// Add tables to logical replication.
// Restricted to MASTER/ADMIN: this runs ALTER PUBLICATION on the publisher and
// ALTER SUBSCRIPTION ... REFRESH on every secondary, i.e. it changes cross-cloud
// replication topology. Previously any authenticated role (including READER)
// could invoke it.
router.post('/add-tables', requireRoles(Role.MASTER, Role.ADMIN), addTables);

export default router;
