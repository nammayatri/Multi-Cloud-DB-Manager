import { Router } from 'express';
import { addTables } from '../controllers/replication.controller';
import { isAuthenticated } from '../middleware/auth.middleware';

const router = Router();

router.use(isAuthenticated);

// Add tables to logical replication
router.post('/add-tables', addTables);

export default router;
