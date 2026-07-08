import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import ClickHouseClientManager from '../config/clickhouse';
import clickHouseSyncService from '../services/clickhouse/ClickHouseSyncService';
import clickHouseBackfillService from '../services/clickhouse/ClickHouseBackfillService';
import historyService from '../services/history.service';
import DatabasePools from '../config/database';
import logger from '../utils/logger';
import { CH_IDENTIFIER_RE } from '../services/clickhouse/ClickHouseBackfillService';

const CH_DATABASE_LABEL = 'clickhouse';
const READ_ONLY_RE = /^(SELECT|WITH|SHOW|DESCRIBE|EXPLAIN)\b/i;

/**
 * Strip leading SQL comments (line + block) and whitespace so the read-vs-write
 * detection regex matches against the first real keyword. Internal comments
 * are preserved — only the leading run is removed.
 */
function stripLeadingSqlComments(s: string): string {
    return s.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s+)+/g, '');
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/** Resolve the primary-cloud pool for a given database name. */
function getPrimaryPool(database: string) {
    const dbPools = DatabasePools.getInstance();
    const cloudConfig = dbPools.getCloudConfig();
    return dbPools.getPoolByName(cloudConfig.primaryCloud, database);
}

/** Get all primary databases with their default schemas. */
function getPrimaryDatabases() {
    const dbPools = DatabasePools.getInstance();
    const cloudConfig = dbPools.getCloudConfig();
    return cloudConfig.primaryDatabases; // Array of DatabaseInfo
}

// ──────────────────────────────────────────────
// Existing endpoints (unchanged)
// ──────────────────────────────────────────────

/**
 * GET /api/clickhouse/status
 * Returns ClickHouse connection health.
 */
export async function getStatus(req: Request, res: Response): Promise<void> {
    const ch = ClickHouseClientManager.getInstance();

    if (!ch) {
        res.json({
            status: 'disabled',
            clickhouse: 'not configured',
            message: 'No clickhouse.json found — ClickHouse sync is disabled',
        });
        return;
    }

    try {
        const alive = await ch.ping();
        res.json({
            status: alive ? 'ok' : 'error',
            clickhouse: alive ? 'connected' : 'unreachable',
            host: ch.config.host,
            database: ch.config.database,
        });
    } catch (err: any) {
        res.status(503).json({
            status: 'error',
            clickhouse: 'unreachable',
            error: err.message,
        });
    }
}

/**
 * POST /api/clickhouse/sync
 * Body: { sql: string, database: string, schema?: string }
 */
export async function manualSync(req: Request, res: Response): Promise<void> {
    const { sql, database, schema } = req.body as {
        sql: string;
        database: string;
        schema?: string;
    };

    if (!sql || !database) {
        res.status(400).json({ error: 'sql and database are required' });
        return;
    }

    const pool = getPrimaryPool(database);
    if (!pool) {
        res.status(404).json({ error: `Database '${database}' not found in primary cloud` });
        return;
    }

    const pgSchema = schema || 'public';

    try {
        const result = await clickHouseSyncService.syncAfterQuery(sql, pool, pgSchema);
        res.json(result);
    } catch (err: any) {
        logger.error('Manual CH sync failed', { error: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * POST /api/clickhouse/query
 * Body: { query: string }
 */
export async function executeQuery(req: Request, res: Response): Promise<void> {
    const ch = ClickHouseClientManager.getInstance();
    if (!ch) {
        res.status(503).json({ error: 'ClickHouse not configured' });
        return;
    }

    const { query } = req.body as { query: string };
    const user = req.user as Express.User;
    const executionId = randomUUID();
    const startedAt = Date.now();
    const trimmed = query.trim();
    const forKeyword = stripLeadingSqlComments(trimmed);
    const isRead = READ_ONLY_RE.test(forKeyword);
    const command = forKeyword.split(/\s+/)[0]?.toUpperCase() ?? 'UNKNOWN';

    try {
        let rows: Array<Record<string, unknown>> = [];
        let fields: Array<{ name: string; dataTypeID: number }> = [];

        if (isRead) {
            const { rows: r, meta } = await ch.queryWithMeta(trimmed);
            rows = r;
            fields = meta.map((m) => ({ name: m.name, dataTypeID: 0 }));
        } else {
            await ch.exec(trimmed);
        }

        const duration_ms = Date.now() - startedAt;
        const response = {
            id: executionId,
            success: true,
            clickhouse: {
                success: true,
                duration_ms,
                result: {
                    rows,
                    fields,
                    rowCount: rows.length,
                    command,
                },
            },
        };

        try {
            await historyService.saveQueryExecution(
                user.id,
                trimmed,
                CH_DATABASE_LABEL,
                CH_DATABASE_LABEL,
                response as any,
            );
        } catch (e: any) {
            logger.warn('CH history save failed (non-fatal)', { error: e.message });
        }

        res.json(response);
    } catch (err: any) {
        const duration_ms = Date.now() - startedAt;
        const response = {
            id: executionId,
            success: false,
            clickhouse: {
                success: false,
                duration_ms,
                error: err.message,
            },
        };

        try {
            await historyService.saveQueryExecution(
                user.id,
                trimmed,
                CH_DATABASE_LABEL,
                CH_DATABASE_LABEL,
                response as any,
            );
        } catch {
            // intentional
        }

        logger.error('CH query failed', { error: err.message, user: (user as any)?.username });
        res.status(200).json(response);
    }
}

// ──────────────────────────────────────────────
// NEW: Column Sync endpoints
// ──────────────────────────────────────────────

/**
 * GET /api/clickhouse/tables
 *
 * Lists all tables across primary PG databases. Deliberately does NOT check ClickHouse —
 * that check is done on-demand per table via checkTableSync(), triggered by a "Check" button
 * in the UI, so this stays a single cheap query per PG database regardless of table count.
 */
export async function listSyncableTables(req: Request, res: Response): Promise<void> {
    const ch = ClickHouseClientManager.getInstance();
    if (!ch) {
        res.json({ tables: [] });
        return;
    }

    const databases = getPrimaryDatabases();
    const dbPools = DatabasePools.getInstance();
    const cloudConfig = dbPools.getCloudConfig();

    const results: Array<{
        pgDatabase: string;
        pgSchema: string;
        table: string;
        chDatabase: string;
    }> = [];

    for (const db of databases) {
        const pool = dbPools.getPoolByName(cloudConfig.primaryCloud, db.databaseName);
        if (!pool) continue;

        try {
            const { rows: pgTables } = await pool.query(`
                SELECT table_schema, table_name
                FROM information_schema.tables
                WHERE table_type = 'BASE TABLE'
                  AND table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
                ORDER BY table_schema, table_name
            `);

            for (const pgTable of pgTables) {
                const pgSchema = pgTable.table_schema as string;
                const table = pgTable.table_name as string;
                results.push({
                    pgDatabase: db.databaseName,
                    pgSchema,
                    table,
                    chDatabase: pgSchema, // convention: pgSchema = chDb
                });
            }
        } catch (err: any) {
            logger.warn(`listSyncableTables: failed to query ${db.databaseName}`, { error: err.message });
        }
    }

    res.json({ tables: results });
}

/**
 * POST /api/clickhouse/check-table
 * Body: { pgDatabase, pgSchema, table }
 *
 * On-demand, single-table column diff between PG and CH — compares by COLUMN NAME,
 * not column count. A count-only comparison can't tell "PG is missing column X" apart
 * from "CH has an extra column Y" (e.g. the `date` sentinel, a `sign` column on a
 * CollapsingMergeTree, or any other CH-only column) — the two differences can silently
 * cancel out and hide a real gap. Extra CH-only columns are returned separately and are
 * never treated as a problem.
 */
export async function checkTableSync(req: Request, res: Response): Promise<void> {
    const { pgDatabase, pgSchema, table } = req.body as {
        pgDatabase: string;
        pgSchema: string;
        table: string;
    };

    if (!pgDatabase || !pgSchema || !table) {
        res.status(400).json({ error: 'pgDatabase, pgSchema, and table are required' });
        return;
    }

    const chDatabase = pgSchema; // convention: pgSchema = chDb
    if (!CH_IDENTIFIER_RE.test(chDatabase) || !CH_IDENTIFIER_RE.test(table)) {
        res.status(400).json({ error: 'pgSchema and table must contain only letters, numbers, and underscores' });
        return;
    }

    const ch = ClickHouseClientManager.getInstance();
    if (!ch) {
        res.status(503).json({ error: 'ClickHouse not configured' });
        return;
    }

    const pool = getPrimaryPool(pgDatabase);
    if (!pool) {
        res.status(404).json({ error: `Database '${pgDatabase}' not found in primary cloud` });
        return;
    }

    try {
        const { rows: pgCols } = await pool.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
            [pgSchema, table],
        );
        const pgColumnNames: string[] = pgCols.map((r: any) => r.column_name);

        if (pgColumnNames.length === 0) {
            res.status(404).json({ error: `Table ${pgSchema}.${table} not found in PG` });
            return;
        }

        let chColumnNames: string[] = [];
        try {
            const chCols = await ch.query<{ name: string }>(
                `SELECT name FROM system.columns WHERE database = '${chDatabase}' AND table = '${table}'`,
            );
            chColumnNames = chCols.map(c => c.name);
        } catch {
            // CH unreachable for this table — treated as "not in CH" below
        }

        const inCH = chColumnNames.length > 0;
        const pgColSet = new Set(pgColumnNames);
        const chColSet = new Set(chColumnNames);

        // Real gap: PG columns absent from CH by name.
        const missingColumns = pgColumnNames.filter(c => !chColSet.has(c));
        // Informational only — CH-only columns (`date` sentinel, `sign`, custom additions, etc).
        const extraChColumns = chColumnNames.filter(c => !pgColSet.has(c));

        res.json({
            pgDatabase,
            pgSchema,
            table,
            chDatabase,
            inCH,
            pgColumnCount: pgColumnNames.length,
            chColumnCount: chColumnNames.length,
            missingColumns,
            extraChColumns,
        });
    } catch (err: any) {
        logger.error('checkTableSync failed', { error: err.message, table });
        res.status(500).json({ error: err.message });
    }
}

/**
 * POST /api/clickhouse/sync-columns
 * Body: { pgDatabase: string, pgSchema: string, table: string }
 *
 * Syncs missing columns from PG → CH (ALTER + rebuild queue+MV).
 */
export async function syncTableColumns(req: Request, res: Response): Promise<void> {
    const { pgDatabase, pgSchema, table } = req.body as {
        pgDatabase: string;
        pgSchema: string;
        table: string;
    };

    if (!pgDatabase || !pgSchema || !table) {
        res.status(400).json({ error: 'pgDatabase, pgSchema, and table are required' });
        return;
    }

    const pool = getPrimaryPool(pgDatabase);
    if (!pool) {
        res.status(404).json({ error: `Database '${pgDatabase}' not found in primary cloud` });
        return;
    }

    try {
        const result = await clickHouseSyncService.syncColumnsFromPg(pgDatabase, pgSchema, table, pool);
        res.json(result);
    } catch (err: any) {
        logger.error('CH sync-columns failed', { error: err.message, table });
        res.status(500).json({ success: false, error: err.message });
    }
}

/**
 * POST /api/clickhouse/create-table
 * Body: { pgDatabase: string, pgSchema: string, table: string }
 *
 * Creates a brand-new table in CH from PG schema (main + queue + MV).
 */
export async function createTable(req: Request, res: Response): Promise<void> {
    const { pgDatabase, pgSchema, table } = req.body as {
        pgDatabase: string;
        pgSchema: string;
        table: string;
    };

    if (!pgDatabase || !pgSchema || !table) {
        res.status(400).json({ error: 'pgDatabase, pgSchema, and table are required' });
        return;
    }

    const pool = getPrimaryPool(pgDatabase);
    if (!pool) {
        res.status(404).json({ error: `Database '${pgDatabase}' not found in primary cloud` });
        return;
    }

    try {
        const result = await clickHouseSyncService.createTableFromPg(pgDatabase, pgSchema, table, pool);
        res.json(result);
    } catch (err: any) {
        logger.error('CH create-table failed', { error: err.message, table });
        res.status(500).json({ success: false, error: err.message });
    }
}

// ──────────────────────────────────────────────
// NEW: Backfill endpoints
// ──────────────────────────────────────────────

/**
 * POST /api/clickhouse/backfill
 * Body: { pgDatabase, pgSchema, table, chDatabase, fromDate, toDate }
 *
 * Starts an async backfill job. Returns { backfillId }.
 */
export async function startBackfill(req: Request, res: Response): Promise<void> {
    const { pgDatabase, pgSchema, table, chDatabase, fromDate, toDate } = req.body as {
        pgDatabase: string;
        pgSchema: string;
        table: string;
        chDatabase: string;
        fromDate: string;
        toDate: string;
    };

    if (!pgDatabase || !pgSchema || !table || !chDatabase || !fromDate || !toDate) {
        res.status(400).json({ error: 'pgDatabase, pgSchema, table, chDatabase, fromDate, toDate are all required' });
        return;
    }

    // chDatabase/table are spliced into raw ClickHouse SQL downstream — reject anything
    // that isn't a plain identifier before it ever reaches the backfill service.
    if (!CH_IDENTIFIER_RE.test(chDatabase) || !CH_IDENTIFIER_RE.test(table)) {
        res.status(400).json({ error: 'chDatabase and table must contain only letters, numbers, and underscores' });
        return;
    }

    // Validate dates
    const from = new Date(fromDate);
    const to = new Date(toDate);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
        return;
    }
    if (from >= to) {
        res.status(400).json({ error: 'fromDate must be before toDate' });
        return;
    }

    const pool = getPrimaryPool(pgDatabase);
    if (!pool) {
        res.status(404).json({ error: `Database '${pgDatabase}' not found in primary cloud` });
        return;
    }

    const ch = ClickHouseClientManager.getInstance();
    if (!ch) {
        res.status(503).json({ error: 'ClickHouse not configured' });
        return;
    }

    const job = clickHouseBackfillService.startBackfill(
        { pgDatabase, pgSchema, table, chDatabase, fromDate, toDate },
        pool,
    );

    logger.info('Backfill started', { id: job.id, table, from: fromDate, to: toDate });
    res.json({ backfillId: job.id, status: job.status });
}

/**
 * GET /api/clickhouse/backfill/:id
 * Returns current status of a backfill job.
 */
export async function getBackfillStatus(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const job = clickHouseBackfillService.getStatus(id);

    if (!job) {
        res.status(404).json({ error: `Backfill job '${id}' not found` });
        return;
    }

    res.json(job);
}

/**
 * POST /api/clickhouse/backfill/:id/cancel
 * Requests cancellation of a running backfill job.
 */
export async function cancelBackfill(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const ok = clickHouseBackfillService.cancel(id);

    if (!ok) {
        const job = clickHouseBackfillService.getStatus(id);
        if (!job) {
            res.status(404).json({ error: `Backfill job '${id}' not found` });
        } else {
            res.status(409).json({ error: `Backfill job is already ${job.status}` });
        }
        return;
    }

    res.json({ success: true, message: 'Cancellation requested — job will stop at the next chunk boundary' });
}
