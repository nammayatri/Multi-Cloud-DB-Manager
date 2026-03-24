import { Router } from 'express';
import { getConfig, getRefs, analyze, getFileContent, refreshRepo } from '../controllers/migrations.controller';
import { isAuthenticated } from '../middleware/auth.middleware';

const router = Router();

// Config and refs are safe (no secrets) — no auth needed
router.get('/config', getConfig);
router.get('/refs', getRefs);

// Analysis and file content require authentication
router.post('/analyze', isAuthenticated, analyze);
router.get('/file', isAuthenticated, getFileContent);
router.post('/refresh-repo', isAuthenticated, refreshRepo);

export default router;
