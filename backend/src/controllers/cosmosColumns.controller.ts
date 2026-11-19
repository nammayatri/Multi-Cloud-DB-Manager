import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import logger from '../utils/logger';
import { ClickHouseUserError } from '../utils/clickhouse-errors';
import { TRANSFORMS, MAX_BATCH } from '../services/cosmosColumns/columnRules';
import * as cosmos from '../services/cosmosColumns/cosmosColumns.service';

const itemSchema = z.object({
  etlConfigName: z.string().min(1),
  sourceColumn: z.string().min(1),
  sourceColumnType: z.string().min(1),
  transformType: z.enum(TRANSFORMS as [string, ...string[]]),
  targetColumnName: z.string().min(1),
  targetColumnType: z.string().min(1),
  targetTables: z.array(z.string().min(1)).min(1).max(2).optional(),
});
export const batchItemsSchema = z.object({ items: z.array(itemSchema).min(1).max(MAX_BATCH) });
/** Apply also takes the id the page polls for progress. */
export const applySchema = batchItemsSchema.extend({ applyId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional() });
export const visibilitySchema = z.object({ etlConfigName: z.string().min(1), column: z.string().min(1), enabled: z.boolean() });

type Items = z.infer<typeof batchItemsSchema>['items'];
const itemsOf = (req: Request) => (req.body as { items: Items }).items as Parameters<typeof cosmos.preview>[0];
const userOf = (req: Request) => req.user?.email ?? 'unknown';

/** 422 with the message for operator-actionable errors (ours and ClickHouse's own), 500 otherwise. */
function fail(res: Response, err: any, what: string) {
  if (err instanceof ClickHouseUserError) return res.status(422).json({ error: err.message });
  const message = String(err?.message ?? '');
  if (/Code: \d+|DB::Exception/.test(message)) {
    logger.warn(`Cosmos columns: ${what} failed in ClickHouse`, { error: message });
    return res.status(422).json({ error: `${what} failed in ClickHouse: ${message.split('\n')[0].slice(0, 300)}` });
  }
  logger.error(`Cosmos columns: ${what} failed`, { error: err?.message });
  return res.status(500).json({ error: `${what} failed: ${err?.message ?? 'unknown error'}` });
}

/** Gate: COSMOS_COLUMNS_REVIEWERS + MASTER / ADMIN / CKH_MANAGER. Use after isAuthenticated. */
export function requireReviewer(req: Request, res: Response, next: NextFunction) {
  const access = cosmos.accessFor(req.user);
  if (!access.allowed) return res.status(403).json({ error: `Not allowed: ${access.reason}`, code: 'NOT_ALLOWED' });
  next();
}

export const getAccess = (req: Request, res: Response) => res.json(cosmos.accessFor(req.user));

export async function getSources(_req: Request, res: Response) {
  try { res.json(await cosmos.listSources()); } catch (err) { fail(res, err, 'Listing sources'); }
}

export async function getColumns(req: Request, res: Response) {
  try { res.json(await cosmos.listColumns(req.params.etlConfigName)); } catch (err) { fail(res, err, 'Listing columns'); }
}

export async function setVisibility(req: Request, res: Response) {
  const { etlConfigName, column, enabled } = req.body as z.infer<typeof visibilitySchema>;
  try { await cosmos.setEnabled(etlConfigName, column, enabled, userOf(req)); res.json({ ok: true }); } catch (err) { fail(res, err, 'Changing the column list'); }
}

export async function previewBatch(req: Request, res: Response) {
  try { res.json(cosmos.preview(itemsOf(req))); } catch (err) { fail(res, err, 'Preview'); }
}

export async function checkBatch(req: Request, res: Response) {
  try { res.json(await cosmos.checkBatch(itemsOf(req))); } catch (err) { fail(res, err, 'Checking the batch'); }
}


export async function saveAndApplyBatch(req: Request, res: Response) {
  const { applyId } = req.body as z.infer<typeof applySchema>;
  try { res.json(await cosmos.applyColumns(itemsOf(req), userOf(req), applyId)); } catch (err) { fail(res, err, 'Applying the batch'); }
}

/** Where a running Apply is; 404 once it is long finished (or ran on another server). */
export function getApplyProgress(req: Request, res: Response) {
  const p = cosmos.applyProgress(req.params.applyId);
  if (!p) return res.status(404).json({ error: 'No such apply.' });
  res.json(p);
}


export async function getBatches(_req: Request, res: Response) {
  try { res.json(await cosmos.listBatches()); } catch (err) { fail(res, err, 'Listing batches'); }
}


export async function deprecateColumn(req: Request, res: Response) {
  try { res.json({ deprecated: await cosmos.deprecateColumn(req.params.name, userOf(req)) }); } catch (err) { fail(res, err, 'Deprecating the column'); }
}
