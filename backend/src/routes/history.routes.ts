import { Router } from 'express';
import { getHistory, getExecutionById } from '../controllers/history.controller';
import { isAuthenticated } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(isAuthenticated);

// Get query history
router.get('/', getHistory);

// Get single execution
router.get('/:id', getExecutionById);

export default router;
