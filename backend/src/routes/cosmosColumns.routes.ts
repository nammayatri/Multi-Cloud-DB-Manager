import { Router } from 'express';
import { isAuthenticated } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import {
  applySchema, batchItemsSchema, checkBatch, deprecateColumn, getAccess, getApplyProgress, getBatches,
  getColumns, getSources, previewBatch, requireReviewer, saveAndApplyBatch, setVisibility, visibilitySchema,
} from '../controllers/cosmosColumns.controller';

const router = Router();

router.use(isAuthenticated);

// Any signed-in user may ask whether they can see the tab.
router.get('/access', getAccess);

router.use(requireReviewer);

// Catalog: the 12 sources the txn ETL reads, and a source's columns (enabled / disabled)
router.get('/sources', getSources);
router.get('/sources/:etlConfigName/columns', getColumns);
router.post('/visibility', validate(visibilitySchema), setVisibility);

// Batches
router.post('/batches/preview', validate(batchItemsSchema), previewBatch);
router.post('/batches/check', validate(batchItemsSchema), checkBatch);
router.post('/batches/apply', validate(applySchema), saveAndApplyBatch);
router.get('/apply-progress/:applyId', getApplyProgress);
router.get('/batches', getBatches);
router.post('/columns/:name/deprecate', deprecateColumn);

export default router;
