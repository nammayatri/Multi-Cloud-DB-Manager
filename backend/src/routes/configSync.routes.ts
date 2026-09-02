import { Router } from 'express';
import {
  startExportAndPatch, getStatus, cancel, streamLog,
  getAssets, updateAsset,
  getAssetHistory, getAssetHistoryEntry, restoreAssetVersion,
} from '../controllers/configSync.controller';
import { isAuthenticated, requireRoles } from '../middleware/auth.middleware';
import { validate, configSyncExportAndPatchSchema, configSyncAssetUpdateSchema } from '../middleware/validation.middleware';
import { Role } from '../constants/roles';

const router = Router();

router.use(isAuthenticated);

// export dumps raw secrets (private keys, API tokens) to disk/S3 — gated the
// same as Config Replicate, deliberately NOT left open like the ungated
// Migration Verifier.
const requireConfigSync = requireRoles(Role.MASTER, Role.ADMIN);
// Single combined flow — the only way to trigger a run. No fromEnv/toEnv in
// the body: which environment this means is resolved entirely server-side
// from CONFIG_SYNC_ALLOWED_ENVS, never exposed to the client.
router.post('/export-and-patch', requireConfigSync, validate(configSyncExportAndPatchSchema), startExportAndPatch);

router.get('/status/:executionId', requireConfigSync, getStatus);
router.post('/cancel/:executionId', requireConfigSync, cancel);
router.get('/stream/:executionId', requireConfigSync, streamLog);

router.get('/assets', requireConfigSync, getAssets);
router.put('/assets/:name', requireConfigSync, validate(configSyncAssetUpdateSchema), updateAsset);
router.get('/assets/:name/history', requireConfigSync, getAssetHistory);
router.get('/assets/history/:historyId', requireConfigSync, getAssetHistoryEntry);
router.post('/assets/history/:historyId/restore', requireConfigSync, restoreAssetVersion);

export default router;
