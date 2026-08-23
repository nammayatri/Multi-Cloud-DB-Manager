import { Request, Response, NextFunction } from 'express';
import DatabasePools from '../config/database';
import logger from '../utils/logger';
import { ColumnClass } from '../types/configReplicate';
import groupsService from '../services/configReplicate/groups.service';
import runsService from '../services/configReplicate/runs.service';
import * as introspection from '../services/configReplicate/introspection.service';
import { classifyColumns, suggestMatchKey } from '../services/configReplicate/classify';
import { runAnalysis } from '../services/configReplicate/analyze.service';
import { applyReplication, DriftError } from '../services/configReplicate/apply.service';

/**
 * The value lists are positional: baseValues[i] belongs to dimensionColumns[i].
 * A length mismatch would silently bind the wrong value to the wrong column, so
 * it is rejected rather than zipped short.
 */
const checkDimensionArity = (
  group: { dimensionColumns: string[] },
  baseValues: string[],
  newValues: string[]
): string | null => {
  const expected = group.dimensionColumns.length;
  if (baseValues.length !== expected || newValues.length !== expected) {
    return (
      `This group has ${expected} dimension column(s) (${group.dimensionColumns.join(', ')}), ` +
      `so it needs ${expected} base and ${expected} new value(s).`
    );
  }
  return null;
};

const resolveTargetPool = (cloud: string, database: string) => {
  const dbPools = DatabasePools.getInstance();
  const pool = dbPools.getPoolByName(cloud, database);
  if (!pool) {
    const available = dbPools.getCloudsForDatabase(database);
    throw Object.assign(
      new Error(
        `No connection configured for database "${database}" on cloud "${cloud}"` +
          (available.length ? `. Available clouds: ${available.join(', ')}` : '')
      ),
      { statusCode: 400 }
    );
  }
  return pool;
};

export const listGroups = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ groups: await groupsService.list() });
  } catch (error) {
    next(error);
  }
};

export const getGroup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await groupsService.getById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json({ group });
  } catch (error) {
    next(error);
  }
};

export const createGroup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const group = await groupsService.create(req.body, user.id);
    logger.info('Config replicate group created', { username: user.username, group: group.name });
    res.status(201).json({ group });
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'A group with that name already exists' });
    }
    next(error);
  }
};

export const updateGroup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const group = await groupsService.update(req.params.id, req.body);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    logger.info('Config replicate group updated', { username: user.username, group: group.name });
    res.json({ group });
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'A group with that name already exists' });
    }
    next(error);
  }
};

export const deleteGroup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const removed = await groupsService.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Group not found' });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

export const introspectTables = async (req: Request, res: Response, next: NextFunction) => {
  const { database, cloud, dimensionColumns } = req.body;
  let client;
  try {
    const pool = resolveTargetPool(cloud, database);
    client = await pool.connect();
    const tables = dimensionColumns?.length
      ? await introspection.listTablesWithDimension(client, dimensionColumns)
      : (await introspection.listTables(client)).map(t => ({ ...t, dimensionColumns: [] }));
    res.json({ tables });
  } catch (error: any) {
    if (error.statusCode === 400) return res.status(400).json({ error: error.message });
    next(error);
  } finally {
    client?.release();
  }
};

export const introspectTable = async (req: Request, res: Response, next: NextFunction) => {
  const { database, cloud, schema, table, dimensionColumns } = req.body;
  let client;
  try {
    const pool = resolveTargetPool(cloud, database);
    client = await pool.connect();

    const columns = await introspection.getColumns(client, schema, table);
    if (columns.length === 0) {
      return res.status(404).json({ error: `Table ${schema}.${table} not found` });
    }

    const keys = await introspection.getUniqueKeys(client, schema, table);
    const present = new Set(columns.map(c => c.columnName));
    const missingDimensions = (dimensionColumns as string[]).filter(c => !present.has(c));
    const suggestion = suggestMatchKey(keys, dimensionColumns);
    const matchColumns = suggestion?.matchColumns || [];
    const classes = classifyColumns(columns, dimensionColumns, matchColumns, {}, keys);

    res.json({
      columns,
      uniqueKeys: keys,
      missingDimensionColumns: missingDimensions,
      hasDimensionColumn: missingDimensions.length === 0,
      suggestedMatchKey: suggestion
        ? { name: suggestion.key.name, columns: matchColumns }
        : null,
      suggestedClassification: classes as Record<string, ColumnClass>,
    });
  } catch (error: any) {
    if (error.statusCode === 400) return res.status(400).json({ error: error.message });
    next(error);
  } finally {
    client?.release();
  }
};

export const analyze = async (req: Request, res: Response, next: NextFunction) => {
  const { groupId, database, cloud, baseValues, newValues } = req.body;
  let client;
  try {
    const group = await groupsService.getById(groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.tables.length === 0) {
      return res.status(400).json({ error: 'This group has no tables configured' });
    }

    const pool = resolveTargetPool(cloud, database);
    client = await pool.connect();

    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    await client.query('SET LOCAL statement_timeout = 30000');

    try {
      const arityError = checkDimensionArity(group, baseValues, newValues);
      if (arityError) {
        return res.status(400).json({ error: arityError });
      }

      const { result } = await runAnalysis(client, group, database, cloud, baseValues, newValues);
      res.json(result);
    } finally {
      await client.query('ROLLBACK').catch(err => logger.error('Analyze rollback failed:', err));
    }
  } catch (error: any) {
    if (error.statusCode === 400) return res.status(400).json({ error: error.message });
    next(error);
  } finally {
    client?.release();
  }
};

export const apply = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const group = await groupsService.getById(req.body.groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const arityError = checkDimensionArity(group, req.body.baseValues, req.body.newValues);
    if (arityError) return res.status(400).json({ error: arityError });

    resolveTargetPool(req.body.cloud, req.body.database);

    const result = await applyReplication(req.body, group, {
      id: user.id,
      username: user.username,
    });

    if (result.status === 'ABORTED') {
      return res.status(409).json({ ...result, code: 'ANALYSIS_STALE' });
    }
    if (result.status === 'FAILED') {
      return res.status(422).json(result);
    }

    logger.info('Config replicate applied', {
      username: user.username,
      group: group.name,
      totals: result.totals,
    });
    res.json(result);
  } catch (error: any) {
    if (error instanceof DriftError) {
      return res.status(409).json({ error: error.message, drift: error.details });
    }
    if (error.statusCode === 400) return res.status(400).json({ error: error.message });
    next(error);
  }
};

export const listRuns = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '25'), 10) || 25, 1), 100);
    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
    const groupId = req.query.groupId ? String(req.query.groupId) : undefined;

    res.json(await runsService.list({ groupId, limit, offset }));
  } catch (error) {
    next(error);
  }
};

export const getRun = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const run = await runsService.getById(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (error) {
    next(error);
  }
};
