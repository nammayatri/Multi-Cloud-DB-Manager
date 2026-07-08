import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import logger from '../../utils/logger';
import ClickHouseClientManager from '../../config/clickhouse';
import ClickHouseDDLBuilder, { CHColumn } from './ClickHouseDDLBuilder';
import ClickHouseTypeMapper from './ClickHouseTypeMapper';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type BackfillGranularity = 'monthly' | 'weekly' | 'daily';
export type BackfillStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackfillJob {
    id: string;
    status: BackfillStatus;
    table: string;
    pgDatabase: string;
    pgSchema: string;
    chDatabase: string;
    fromDate: string;
    toDate: string;
    totalChunks: number;
    completedChunks: number;
    rowsInserted: number;
    currentPeriod: string;
    granularity: BackfillGranularity;
    error?: string;
    startedAt: Date;
    completedAt?: Date;
    cancelRequested: boolean;
}

export interface BackfillStartParams {
    pgDatabase: string;
    pgSchema: string;
    table: string;
    chDatabase: string;
    fromDate: string;   // ISO date string: "2024-01-01"
    toDate: string;     // ISO date string: "2024-12-31"
}

/** Strict identifier allowlist — anything reaching a raw SQL string (chDatabase, table) must match this. */
export const CH_IDENTIFIER_RE = /^[a-zA-Z0-9_]+$/;

/** Per-chunk PG fetch timeout — overrides the shared pool's default `statement_timeout`
 *  since backfill queries routinely scan far more data than interactive queries. */
const BACKFILL_STATEMENT_TIMEOUT_MS = 5 * 60 * 1000;

// ──────────────────────────────────────────────
// Date helpers
// ──────────────────────────────────────────────

/** Advance a date by N months */
function addMonths(d: Date, n: number): Date {
    const r = new Date(d);
    r.setUTCMonth(r.getUTCMonth() + n);
    return r;
}

/** Advance a date by N days */
function addDays(d: Date, n: number): Date {
    const r = new Date(d);
    r.setUTCDate(r.getUTCDate() + n);
    return r;
}

/** Advance to start of next week (Monday) */
function nextWeekStart(d: Date): Date {
    const r = new Date(d);
    r.setUTCDate(r.getUTCDate() + 7);
    return r;
}

/** Build a list of monthly [start, end) pairs spanning [from, to] */
function monthlyChunks(from: Date, to: Date): Array<[Date, Date]> {
    const chunks: Array<[Date, Date]> = [];
    let cursor = new Date(from);
    while (cursor < to) {
        const end = addMonths(cursor, 1);
        chunks.push([cursor, end > to ? to : end]);
        cursor = end;
    }
    return chunks;
}

/** Build weekly [start, end) pairs within a month range */
function weeklyChunks(from: Date, to: Date): Array<[Date, Date]> {
    const chunks: Array<[Date, Date]> = [];
    let cursor = new Date(from);
    while (cursor < to) {
        const end = nextWeekStart(cursor);
        chunks.push([cursor, end > to ? to : end]);
        cursor = end;
    }
    return chunks;
}

/** Build daily [start, end) pairs within a range */
function dailyChunks(from: Date, to: Date): Array<[Date, Date]> {
    const chunks: Array<[Date, Date]> = [];
    let cursor = new Date(from);
    while (cursor < to) {
        const end = addDays(cursor, 1);
        chunks.push([cursor, end > to ? to : end]);
        cursor = end;
    }
    return chunks;
}

/** Format a date range label for display */
function periodLabel(start: Date, end: Date, granularity: BackfillGranularity): string {
    const s = start.toISOString().slice(0, 10);
    const e = addDays(end, -1).toISOString().slice(0, 10);
    return granularity === 'daily' ? s : `${s} → ${e}`;
}

// ──────────────────────────────────────────────
// PG helpers
// ──────────────────────────────────────────────

async function getPgColumns(
    pool: Pool,
    schema: string,
    table: string,
): Promise<Array<{ column_name: string; data_type: string; is_nullable: string; udt_name: string }>> {
    const { rows } = await pool.query(
        `SELECT column_name, data_type, is_nullable, udt_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, table],
    );
    return rows;
}

async function fetchChunk(
    pool: Pool,
    schema: string,
    table: string,
    dateCol: string | null,
    start: Date,
    end: Date,
): Promise<Record<string, unknown>[]> {
    // Use a dedicated client so we can raise statement_timeout for this query only —
    // the shared pgPool's default (30s) is tuned for interactive queries, not full-table backfill scans.
    const client = await pool.connect();
    try {
        await client.query(`SET statement_timeout = ${BACKFILL_STATEMENT_TIMEOUT_MS}`);
        if (!dateCol) {
            // No date column: full table in one chunk (called once)
            const { rows } = await client.query(`SELECT * FROM "${schema}"."${table}"`);
            return rows;
        }
        const { rows } = await client.query(
            `SELECT * FROM "${schema}"."${table}"
             WHERE "${dateCol}" >= $1 AND "${dateCol}" < $2`,
            [start, end],
        );
        return rows;
    } finally {
        await client.query('SET statement_timeout = DEFAULT').catch(() => {});
        client.release();
    }
}

// ──────────────────────────────────────────────
// CH helpers
// ──────────────────────────────────────────────

/** Map PG rows to CHColumn array */
function mapColumns(
    pgRows: Array<{ column_name: string; data_type: string; is_nullable: string; udt_name: string }>,
): CHColumn[] {
    return pgRows.map(r => ({
        name: r.column_name,
        chType: ClickHouseTypeMapper.map(r.data_type, r.udt_name, r.is_nullable),
    }));
}

/** Escape a string for a ClickHouse string literal (C-style: \\ and \' are the recognized escapes). */
function escapeChString(v: string): string {
    return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Serialize a single JS value to a ClickHouse SQL literal for the given column's CH type. */
function serializeChValue(v: unknown): string {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'boolean') return `'${v ? 'true' : 'false'}'`;
    if (v instanceof Date) return `'${v.toISOString().replace('T', ' ').slice(0, 19)}'`;
    if (Buffer.isBuffer(v)) return `'${escapeChString(v.toString('utf8'))}'`;
    if (Array.isArray(v)) {
        // CH array literal, e.g. [1, 2, 3] or ['a', 'b'] — matches Array(Nullable(...)) mapping.
        // Recurse through serializeChValue itself so element handling (Date/Buffer/boolean/etc)
        // can never drift from the scalar path above.
        return `[${v.map(el => serializeChValue(el)).join(', ')}]`;
    }
    if (typeof v === 'number') {
        // ClickHouse spells non-finite floats `nan`/`inf`/`-inf`, not JS's `NaN`/`Infinity`/`-Infinity`.
        if (Number.isNaN(v)) return 'nan';
        if (v === Infinity) return 'inf';
        if (v === -Infinity) return '-inf';
        return String(v);
    }
    if (typeof v === 'object') return `'${escapeChString(JSON.stringify(v))}'`; // jsonb
    if (typeof v === 'string') return `'${escapeChString(v)}'`;
    return String(v);
}

async function insertChunkIntoClickHouse(
    chManager: ClickHouseClientManager,
    chDb: string,
    table: string,
    columns: CHColumn[],
    rows: Record<string, unknown>[],
): Promise<void> {
    if (rows.length === 0) return;
    if (!CH_IDENTIFIER_RE.test(chDb) || !CH_IDENTIFIER_RE.test(table)) {
        throw new Error(`Invalid ClickHouse database/table identifier: '${chDb}'.'${table}'`);
    }
    // Build column name list (excluding CH sentinel `date` which has a DEFAULT)
    const colNames = columns.map(c => `\`${c.name}\``).join(', ');
    const values = rows
        .map(row => {
            const vals = columns.map(c => serializeChValue(row[c.name]));
            return `(${vals.join(', ')})`;
        })
        .join(',\n');

    const sql = `INSERT INTO \`${chDb}\`.\`${table}\` (${colNames}) VALUES ${values}`;
    await chManager.exec(sql);
}

// ──────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────

export class ClickHouseBackfillService {
    private jobs: Map<string, BackfillJob> = new Map();

    /** Start an async backfill job. Returns the job ID immediately. */
    public startBackfill(params: BackfillStartParams, pgPool: Pool): BackfillJob {
        const id = randomUUID();
        const job: BackfillJob = {
            id,
            status: 'running',
            table: params.table,
            pgDatabase: params.pgDatabase,
            pgSchema: params.pgSchema,
            chDatabase: params.chDatabase,
            fromDate: params.fromDate,
            toDate: params.toDate,
            totalChunks: 0,
            completedChunks: 0,
            rowsInserted: 0,
            currentPeriod: 'Initialising…',
            granularity: 'monthly',
            startedAt: new Date(),
            cancelRequested: false,
        };
        this.jobs.set(id, job);

        // Fire-and-forget — runs async in background
        this.runBackfill(job, pgPool).catch(err => {
            logger.error(`Backfill ${id} crashed`, { error: err.message });
            job.status = 'failed';
            job.error = err.message;
            job.completedAt = new Date();
        });

        return job;
    }

    public getStatus(id: string): BackfillJob | null {
        return this.jobs.get(id) ?? null;
    }

    public cancel(id: string): boolean {
        const job = this.jobs.get(id);
        if (!job || job.status !== 'running') return false;
        job.cancelRequested = true;
        return true;
    }

    /** List all jobs (newest first) for status overview */
    public listJobs(): BackfillJob[] {
        return Array.from(this.jobs.values()).sort(
            (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
        );
    }

    // ──────────────────────────────────────────────
    // Core backfill runner
    // ──────────────────────────────────────────────

    private async runBackfill(job: BackfillJob, pgPool: Pool): Promise<void> {
        const chManager = ClickHouseClientManager.getInstance();
        if (!chManager) {
            job.status = 'failed';
            job.error = 'ClickHouse not configured';
            job.completedAt = new Date();
            return;
        }

        // Fetch PG columns
        const pgRows = await getPgColumns(pgPool, job.pgSchema, job.table);
        if (pgRows.length === 0) {
            job.status = 'failed';
            job.error = `Table ${job.pgSchema}.${job.table} not found in PG`;
            job.completedAt = new Date();
            return;
        }

        const columns = mapColumns(pgRows);

        // Find date column for range filtering
        const dateColMeta = ClickHouseDDLBuilder.findDateTimeColumn(columns);
        const dateCol = dateColMeta?.name ?? null;

        const from = new Date(job.fromDate + 'T00:00:00Z');
        const to = new Date(job.toDate + 'T00:00:00Z');

        if (!dateCol) {
            // No date column: do a single full-table chunk
            logger.warn(`Backfill ${job.id}: no DateTime column — doing full-table single chunk`);
            job.totalChunks = 1;
            job.currentPeriod = 'Full table (no date column)';
            try {
                await this.tryChunk(job, pgPool, chManager, columns, null, from, to);
                job.completedChunks = 1;
            } catch (err: any) {
                job.status = 'failed';
                job.error = `Full-table chunk failed: ${err.message}`;
                job.completedAt = new Date();
                return;
            }
            job.status = 'completed';
            job.completedAt = new Date();
            return;
        }

        // Compute monthly chunks for total count estimate
        const months = monthlyChunks(from, to);
        job.totalChunks = months.length; // approximate; will grow on fallback

        for (const [mStart, mEnd] of months) {
            if (job.cancelRequested) {
                job.status = 'cancelled';
                job.completedAt = new Date();
                return;
            }

            job.granularity = 'monthly';
            job.currentPeriod = periodLabel(mStart, mEnd, 'monthly');

            try {
                await this.tryChunk(job, pgPool, chManager, columns, dateCol, mStart, mEnd);
                job.completedChunks++;
                continue;
            } catch (monthErr: any) {
                logger.warn(`Backfill ${job.id}: monthly chunk failed, falling back to weekly`, {
                    period: job.currentPeriod, error: monthErr.message,
                });
            }

            // Monthly failed — try weekly
            const weeks = weeklyChunks(mStart, mEnd);
            job.totalChunks += weeks.length - 1; // replace the 1 monthly with N weeklies

            let monthSuccess = true;
            for (const [wStart, wEnd] of weeks) {
                if (job.cancelRequested) {
                    job.status = 'cancelled';
                    job.completedAt = new Date();
                    return;
                }

                job.granularity = 'weekly';
                job.currentPeriod = periodLabel(wStart, wEnd, 'weekly');

                try {
                    await this.tryChunk(job, pgPool, chManager, columns, dateCol, wStart, wEnd);
                    job.completedChunks++;
                    continue;
                } catch (weekErr: any) {
                    logger.warn(`Backfill ${job.id}: weekly chunk failed, falling back to daily`, {
                        period: job.currentPeriod, error: weekErr.message,
                    });
                }

                // Weekly failed — try daily
                const days = dailyChunks(wStart, wEnd);
                job.totalChunks += days.length - 1;

                let weekSuccess = true;
                for (const [dStart, dEnd] of days) {
                    if (job.cancelRequested) {
                        job.status = 'cancelled';
                        job.completedAt = new Date();
                        return;
                    }

                    job.granularity = 'daily';
                    job.currentPeriod = periodLabel(dStart, dEnd, 'daily');

                    try {
                        await this.tryChunk(job, pgPool, chManager, columns, dateCol, dStart, dEnd);
                        job.completedChunks++;
                    } catch (dayErr: any) {
                        // Day failed — stop the entire backfill
                        logger.error(`Backfill ${job.id}: daily chunk failed — stopping`, {
                            period: job.currentPeriod, error: dayErr.message,
                        });
                        job.status = 'failed';
                        job.error = `Failed at day ${job.currentPeriod}: ${dayErr.message}`;
                        job.completedAt = new Date();
                        weekSuccess = false;
                        monthSuccess = false;
                        return;
                    }
                }

                if (!weekSuccess) {
                    monthSuccess = false;
                    break;
                }
            }

            if (!monthSuccess) break;
        }

        if (job.status === 'running') {
            job.status = 'completed';
            job.completedAt = new Date();
            logger.info(`Backfill ${job.id} completed`, {
                table: job.table, rowsInserted: job.rowsInserted,
            });
        }
    }

    /** Fetch chunk from PG and insert into CH. Throws on any error. */
    private async tryChunk(
        job: BackfillJob,
        pgPool: Pool,
        chManager: ClickHouseClientManager,
        columns: CHColumn[],
        dateCol: string | null,
        start: Date,
        end: Date,
    ): Promise<void> {
        const rows = await fetchChunk(pgPool, job.pgSchema, job.table, dateCol, start, end);
        logger.debug(`Backfill ${job.id}: chunk ${job.currentPeriod} — ${rows.length} rows`);

        // Insert in batches of 5000 to avoid oversized requests
        const BATCH = 5000;
        for (let i = 0; i < rows.length; i += BATCH) {
            const slice = rows.slice(i, i + BATCH);
            await insertChunkIntoClickHouse(chManager, job.chDatabase, job.table, columns, slice);
            job.rowsInserted += slice.length;
        }
    }
}

export default new ClickHouseBackfillService();
