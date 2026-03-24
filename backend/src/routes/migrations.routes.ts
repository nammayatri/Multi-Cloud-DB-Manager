import { Router } from 'express';
import { getConfig, getRefs, analyze, getFileContent, refreshRepo } from '../controllers/migrations.controller';
import { isAuthenticated } from '../middleware/auth.middleware';

const router = Router();

// All endpoints require authentication
router.use(isAuthenticated);

router.get('/config', getConfig);
router.get('/refs', getRefs);
router.post('/analyze', analyze);
router.get('/file', getFileContent);
router.post('/refresh-repo', refreshRepo);

export default router;
