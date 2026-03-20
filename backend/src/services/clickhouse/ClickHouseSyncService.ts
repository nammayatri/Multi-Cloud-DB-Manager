import { Pool } from 'pg';
import logger from '../../utils/logger';
import ClickHouseClientManager from '../../config/clickhouse';
import { ClickHouseKafkaConfig } from '../../config/clickhouse-config-loader';
import ClickHouseTypeMapper from './ClickHouseTypeMapper';
import ClickHouseDDLBuilder, { CHColumn, CH_SENTINEL_COLUMN, ExtractedKafkaConfig } from './ClickHouseDDLBuilder';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface CHSyncResult {
    success: boolean;
    action: 'created' | 'altered' | 'skipped' | 'disabled';
    table?: string;
    details: string;
    error?: string;
}

interface ParsedCreateTable {
    kind: 'CREATE_TABLE';
    schema: string;
    table: string;
}

interface ParsedAlterAddColumn {
    kind: 'ALTER_ADD_COLUMN';
    schema: string;
    table: string;
    columns: string[];   // new column names
}

type ParsedDDL = ParsedCreateTable | ParsedAlterAddColumn | { kind: 'SKIP' };

// ──────────────────────────────────────────────
// SQL Parser helpers
// ──────────────────────────────────────────────

/**
 * Strip SQL comments and normalise whitespace for pattern matching.
 */
function clean(sql: string): string {
    return sql
        .replace(/--.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Split SQL on semicolons while respecting single- and double-quoted strings.
 * Prevents incorrectly splitting on semicolons inside string literals like
 * DEFAULT 'foo;bar'.
 */
function splitStatements(sql: string): string[] {
    const stmts: string[] = [];
    let current = '';
    let inString = false;
    let stringChar = '';
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (inString) {
            current += ch;
            // Handle escaped quotes ('' in SQL, or \' in some drivers)
            if (ch === stringChar && sql[i + 1] === stringChar) {
                current += sql[++i]; // consume escaped quote char
            } else if (ch === stringChar) {
                inString = false;
            }
        } else if (ch === "'" || ch === '"') {
            inString = true;
            stringChar = ch;
            current += ch;
        } else if (ch === ';') {
            const trimmed = current.trim();
            if (trimmed) stmts.push(trimmed);
            current = '';
        } else {
            current += ch;
        }
    }
    const trimmed = current.trim();
    if (trimmed) stmts.push(trimmed);
    return stmts;
}

/**
 * Parse the SQL and return what kind of DDL it is (or SKIP).
 * Handles both schema-qualified and unqualified table names.
 */
function parseDDL(sql: string, defaultSchema: string): ParsedDDL {
    const c = clean(sql);

    // ── CREATE TABLE ──────────────────────────────────────
    // Matches: CREATE [TEMP] TABLE [IF NOT EXISTS] [schema.]table
    const createMatch = c.match(
        /CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)?)\s*\(/i,
    );
    if (createMatch) {
        const [schema, table] = qualifiedName(createMatch[1], defaultSchema);
        return { kind: 'CREATE_TABLE', schema, table };
    }

    // ── ALTER TABLE ADD COLUMN ────────────────────────────
    // Matches: ALTER TABLE [schema.]table ADD [COLUMN] col_name ...
    // Supports both bare identifiers and double-quoted identifiers (e.g. "my-col").
    const alterMatch = c.match(
        /ALTER\s+TABLE\s+([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)?)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!(CONSTRAINT|INDEX|PRIMARY|UNIQUE|CHECK|FOREIGN)\b)("[^"]+"|[a-zA-Z0-9_]+)/i,
    );
    if (alterMatch) {
        // Collect ALL ADD COLUMN targets (there may be multiple via ADD COLUMN ... ADD COLUMN ...)
        const [schema, table] = qualifiedName(alterMatch[1], defaultSchema);
        const newCols = extractAddedColumns(c);
        if (newCols.length === 0) return { kind: 'SKIP' };
        return { kind: 'ALTER_ADD_COLUMN', schema, table, columns: newCols };
    }

    return { kind: 'SKIP' };
}

/** Split "schema.table" → [schema, table], defaulting schema when absent. */
function qualifiedName(raw: string, defaultSchema: string): [string, string] {
    const parts = raw.split('.');
    return parts.length === 2 ? [parts[0], parts[1]] : [defaultSchema, parts[0]];
}

/**
 * Extract all column names from ADD COLUMN / ADD COLUMN IF NOT EXISTS clauses.
 */
function extractAddedColumns(cleanedSql: string): string[] {
    const cols: string[] = [];
    // Match every occurrence of ADD [COLUMN] [IF NOT EXISTS] <name>
    // Supports bare identifiers and double-quoted identifiers (e.g. "my-col").
    // Negative lookahead prevents matching ADD CONSTRAINT / ADD INDEX / etc.
    const re = /ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!(CONSTRAINT|INDEX|PRIMARY|UNIQUE|CHECK|FOREIGN)\b)("([^"]+)"|([a-zA-Z0-9_]+))/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleanedSql)) !== null) {
        // m[3] = name inside double-quotes, m[4] = bare identifier
        cols.push(m[3] ?? m[4]);
    }
    return cols;
}

// ──────────────────────────────────────────────
// PG introspection
// ──────────────────────────────────────────────

/**
 * Fetch full column list for a table from PG information_schema.
 */
async function pgColumns(
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

/**
 * Fetch only specific column(s) by name from PG information_schema.
 */
async function pgColumnsFor(
    pool: Pool,
    schema: string,
    table: string,
    columnNames: string[],
): Promise<Array<{ column_name: string; data_type: string; is_nullable: string; udt_name: string }>> {
    const { rows } = await pool.query(
        `SELECT column_name, data_type, is_nullable, udt_name
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
       AND column_name = ANY($3::text[])
     ORDER BY ordinal_position`,
        [schema, table, columnNames],
    );
    return rows;
}

/**
 * Map PG rows → CHColumn array.
 */
function mapColumns(
    rows: Array<{ column_name: string; data_type: string; is_nullable: string; udt_name: string }>,
): CHColumn[] {
    return rows.map(r => ({
        name: r.column_name,
        chType: ClickHouseTypeMapper.map(r.data_type, r.udt_name, r.is_nullable),
    }));
}

// ──────────────────────────────────────────────
// CH system.columns fetch (for ALTER rebuild)
// ──────────────────────────────────────────────

/**
 * Fetch the current column list from ClickHouse system.columns.
 * Used to rebuild queue + MV DDL from scratch after an ALTER ADD COLUMN.
 * The `date` sentinel column is excluded (it's managed separately in the main table).
 */
async function chCurrentColumns(
    chManager: ClickHouseClientManager,
    db: string,
    table: string,
): Promise<CHColumn[]> {
    const rows = await chManager.query<{ name: string; type: string }>(
        `SELECT name, type
     FROM system.columns
     WHERE database = '${db}' AND table = '${table}'
     ORDER BY position`,
    );
    // Exclude the sentinel version column — it only belongs on the main table, not queue/MV
    return rows
        .filter(r => r.name !== CH_SENTINEL_COLUMN)
        .map(r => ({ name: r.name, chType: r.type }));
}

/**
 * Fetch the column list from the queue table (e.g. {table}_queue).
 * Used to detect whether the queue uses Pattern A (JSONEachRow, multiple columns)
 * or Pattern B (JSONAsString, single `message` column).
 */
async function chQueueColumns(
    chManager: ClickHouseClientManager,
    db: string,
    table: string,
): Promise<CHColumn[]> {
    const rows = await chManager.query<{ name: string; type: string }>(
        `SELECT name, type
     FROM system.columns
     WHERE database = '${db}' AND table = '${table}_queue'
     ORDER BY position`,
    );
    return rows.map(r => ({ name: r.name, chType: r.type }));
}

/**
 * Returns true if the given table exists in ClickHouse system.tables.
 * Used to detect "orphaned" PG tables that were never mirrored (or were dropped) in CH.
 */
async function chTableExists(
    chManager: ClickHouseClientManager,
    db: string,
    table: string,
): Promise<boolean> {
    const rows = await chManager.query<{ name: string }>(
        `SELECT name FROM system.tables WHERE database = '${db}' AND name = '${table}' LIMIT 1`,
    );
    return rows.length > 0;
}

// ──────────────────────────────────────────────
// Kafka config helpers
// ──────────────────────────────────────────────

async function getKafkaQueueConfig(
    chManager: ClickHouseClientManager,
    db: string,
    table: string,
): Promise<ExtractedKafkaConfig | null> {
    try {
        const rows = await chManager.query<{ create_table_query: string }>(
            `SELECT create_table_query FROM system.tables WHERE database = '${db}' AND name = '${table}_queue' LIMIT 1`,
        );
        if (rows.length === 0 || !rows[0].create_table_query) return null;

        const ddl = rows[0].create_table_query;
        const brokerMatch = ddl.match(/kafka_broker_list\s*=\s*'([^']+)'/);
        const topicMatch = ddl.match(/kafka_topic_list\s*=\s*'([^']+)'/);
        const groupMatch = ddl.match(/kafka_group_name\s*=\s*'([^']+)'/);
        const formatMatch = ddl.match(/kafka_format\s*=\s*'([^']+)'/);

        if (brokerMatch && topicMatch && groupMatch && formatMatch) {
            return {
                kafka_broker_list: brokerMatch[1],
                kafka_topic_list: topicMatch[1],
                kafka_group_name: groupMatch[1],
                kafka_format: formatMatch[1],
            };
        }
    } catch (err) {
        logger.error(`Failed to extract Kafka config for ${db}.${table}_queue`, { error: err });
    }
    return null;
}

function getDefaultKafkaConfig(db: string, table: string, fallbackCfg: ClickHouseKafkaConfig): ExtractedKafkaConfig {
    const cleanTable = table.replace(/_/g, '').replace(/\s+/g, '').toLowerCase();
    if (db === 'atlas_app') {
        return {
            kafka_broker_list: 'eks-kurukshetra-kafka-3-e2e26d957f42486c.elb.ap-south-1.amazonaws.com:9096',
            kafka_topic_list: `aap-sessionizer-${cleanTable}`,
            kafka_group_name: `aap-sessionizer-${cleanTable}-ec2-ckh-consumer-v2`,
            kafka_format: 'JSONEachRow',
        };
    } else if (db === 'atlas_driver_offer_bpp') {
        return {
            kafka_broker_list: 'eks-kurukshetra-kafka-3-e2e26d957f42486c.elb.ap-south-1.amazonaws.com:9096',
            kafka_topic_list: `adob-sessionizer-${cleanTable}`,
            kafka_group_name: `adob-sessionizer-${cleanTable}-ec2-ckh-consumer`,
            kafka_format: 'JSONEachRow',
        };
    }
    
    return {
        kafka_broker_list: fallbackCfg.brokerList,
        kafka_topic_list: ClickHouseDDLBuilder.topicName(db, table, fallbackCfg.topicMiddle),
        kafka_group_name: ClickHouseDDLBuilder.groupName(db, table, fallbackCfg),
        kafka_format: 'JSONEachRow'
    };
}

// ──────────────────────────────────────────────
// Main service
// ──────────────────────────────────────────────

export class ClickHouseSyncService {
    /**
     * Called non-blocking after each successful PG execution.
     * Parses the SQL, determines the DDL action, and mirrors it to ClickHouse.
     *
     * @param sql          - The SQL that was executed in PG
     * @param pgPool       - The PG connection pool to introspect schema info
     * @param pgSchema     - The default schema used for the query (e.g. "atlas_driver_offer_bpp")
     */
    public async syncAfterQuery(
        sql: string,
        pgPool: Pool,
        pgSchema: string,
    ): Promise<CHSyncResult> {
        // Check if ClickHouse is configured
        const chManager = ClickHouseClientManager.getInstance();
        if (!chManager) {
            return { success: true, action: 'disabled', details: 'ClickHouse not configured' };
        }

        const { config } = chManager;
        const cluster = config.cluster;
        const kafkaCfg = config.kafka;
        const selectUsers = config.selectUsers ?? [];

        // Parse each statement in the SQL (quote-aware split — respects semicolons inside string literals)
        const statements = splitStatements(sql);

        const results: CHSyncResult[] = [];

        for (const stmt of statements) {
            const parsed = parseDDL(stmt, pgSchema);
            if (parsed.kind === 'SKIP') continue;

            // Use the PG schema (parsed from SQL) as the CH database.
            // e.g. CREATE TABLE atlas_app.orders → CH database = "atlas_app"
            // Falls back to pgSchema default if no schema qualifier in the SQL.
            const chDb = parsed.schema;

            try {
                const result = parsed.kind === 'CREATE_TABLE'
                    ? await this.handleCreateTable(parsed, pgPool, chManager, chDb, cluster, kafkaCfg, selectUsers)
                    : await this.handleAlterAddColumn(parsed, pgPool, chManager, chDb, cluster, kafkaCfg, selectUsers);
                results.push(result);
            } catch (err: any) {
                logger.error('ClickHouse sync error', { stmt: stmt.slice(0, 100), error: err.message });
                results.push({
                    success: false,
                    action: parsed.kind === 'CREATE_TABLE' ? 'created' : 'altered',
                    table: parsed.table,
                    details: 'CH sync failed',
                    error: err.message,
                });
            }
        }

        if (results.length === 0) {
            return { success: true, action: 'skipped', details: 'No DDL statements detected' };
        }

        // If multiple statements, roll up into one result
        const allOk = results.every(r => r.success);
        return {
            success: allOk,
            action: results[0].action,
            table: results.map(r => r.table).filter(Boolean).join(', '),
            details: results.map(r => r.details).join(' | '),
            error: results.map(r => r.error).filter(Boolean).join(' | ') || undefined,
        };
    }

    // ──────────────────────────────────────────────
    // CREATE TABLE flow
    // ──────────────────────────────────────────────

    private async handleCreateTable(
        parsed: ParsedCreateTable,
        pgPool: Pool,
        ch: ClickHouseClientManager,
        chDb: string,
        cluster: string,
        kafkaCfg: ClickHouseKafkaConfig,
        selectUsers: string[] = [],
    ): Promise<CHSyncResult> {
        const { schema, table } = parsed;
        logger.info(`CH sync: CREATE TABLE ${schema}.${table}`);

        // 1. Fetch columns from PG
        const pgRows = await pgColumns(pgPool, schema, table);
        if (pgRows.length === 0) {
            return {
                success: false,
                action: 'created',
                table,
                details: `Table ${schema}.${table} not found in PG information_schema after CREATE`,
                error: 'Table not found in PG',
            };
        }
        const columns = mapColumns(pgRows);

        // 2. Build and execute CH main table DDL
        const createTableDDL = ClickHouseDDLBuilder.buildCreateTable(chDb, table, cluster, columns);
        logger.debug('CH CREATE TABLE DDL', { ddl: createTableDDL });
        await ch.exec(createTableDDL);

        // 3. Build and execute queue DDL
        const queueConfig = getDefaultKafkaConfig(chDb, table, kafkaCfg);
        const queueDDL = ClickHouseDDLBuilder.buildQueue(chDb, table, cluster, columns, queueConfig);
        logger.debug('CH CREATE QUEUE DDL', { ddl: queueDDL });
        await ch.exec(queueDDL);

        // 4. Build and execute MV DDL
        const mvDDL = ClickHouseDDLBuilder.buildMaterializedView(chDb, table, cluster, columns);
        logger.debug('CH CREATE MV DDL', { ddl: mvDDL });
        await ch.exec(mvDDL);

        // 5. Grant SELECT on main table to configured users (if any)
        if (selectUsers.length > 0) {
            const grantDDL = ClickHouseDDLBuilder.buildGrant(chDb, table, cluster, selectUsers);
            logger.debug('CH GRANT DDL', { ddl: grantDDL });
            await ch.exec(grantDDL);
        }


        logger.info(`CH sync: created ${table}, ${table}_queue, ${table}_mv in ${chDb}`);

        return {
            success: true,
            action: 'created',
            table,
            details: `Created ${chDb}.${table}, ${chDb}.${table}_queue, ${chDb}.${table}_mv`,
        };
    }

    // ──────────────────────────────────────────────
    // ALTER TABLE ADD COLUMN flow
    // ──────────────────────────────────────────────

    private async handleAlterAddColumn(
        parsed: ParsedAlterAddColumn,
        pgPool: Pool,
        ch: ClickHouseClientManager,
        chDb: string,
        cluster: string,
        kafkaCfg: ClickHouseKafkaConfig,
        selectUsers: string[] = [],
    ): Promise<CHSyncResult> {
        const { schema, table, columns: newColNames } = parsed;
        logger.info(`CH sync: ALTER TABLE ${schema}.${table} ADD COLUMN(s): ${newColNames.join(', ')}`);

        // 0. Guard: if the CH table doesn't exist at all, bootstrap it from the full PG schema
        //    rather than trying to ALTER a non-existent table.
        const tableExists = await chTableExists(ch, chDb, table);
        if (!tableExists) {
            logger.warn(
                `CH sync: table ${chDb}.${table} not found in ClickHouse; ` +
                `bootstrapping full CREATE from PG schema instead of ALTER`,
            );
            const allPgRows = await pgColumns(pgPool, schema, table);
            if (allPgRows.length === 0) {
                return {
                    success: false,
                    action: 'altered',
                    table,
                    details: `Bootstrap failed: ${schema}.${table} not found in PG information_schema`,
                    error: 'Table not found in PG',
                };
            }
            const allColumns = mapColumns(allPgRows);
            const createTableDDL = ClickHouseDDLBuilder.buildCreateTable(chDb, table, cluster, allColumns);
            await ch.exec(createTableDDL);
            const queueConfig = getDefaultKafkaConfig(chDb, table, kafkaCfg);
            const queueDDL = ClickHouseDDLBuilder.buildQueue(chDb, table, cluster, allColumns, queueConfig);
            await ch.exec(queueDDL);
            const mvDDL = ClickHouseDDLBuilder.buildMaterializedView(chDb, table, cluster, allColumns);
            await ch.exec(mvDDL);
            if (selectUsers.length > 0) {
                const grantDDL = ClickHouseDDLBuilder.buildGrant(chDb, table, cluster, selectUsers);
                await ch.exec(grantDDL);
            }
            logger.info(`CH sync: bootstrapped missing table ${chDb}.${table} (queue + MV) from PG schema`);
            return {
                success: true,
                action: 'created',
                table,
                details: `Bootstrapped missing CH table ${chDb}.${table} (and queue + MV) from current PG schema`,
            };
        }

        // 1. Fetch ALL columns from PG
        const pgRows = await pgColumns(pgPool, schema, table);
        if (pgRows.length === 0) {
            return {
                success: false,
                action: 'altered',
                table,
                details: `Table ${schema}.${table} not found in PG information_schema`,
                error: 'Table not found in PG',
            };
        }

        // 1b. Fetch ALL columns from CH (main table)
        const currentChCols = await chCurrentColumns(ch, chDb, table);
        const chColNames = new Set(currentChCols.map(c => c.name));

        // 1c. Find columns in PG that missing in CH
        const missingPgRows = pgRows.filter(r => !chColNames.has(r.column_name));

        if (missingPgRows.length === 0) {
             return { success: true, action: 'skipped', table, details: `No missing columns to add to ${chDb}.${table}` };
        }

        const mappedPgCols = mapColumns(pgRows);
        const newColumns = mappedPgCols
            .filter(c => missingPgRows.some(m => m.column_name === c.name))
            .map(col => ({
                ...col,
                // Force Nullable for ALTER ADD COLUMN
                chType: col.chType.startsWith('Nullable(') || col.chType.startsWith('Array(')
                    ? col.chType
                    : `Nullable(${col.chType})`,
            }));
            
        const addedColNames = newColumns.map(c => c.name);

        // 2. ALTER the main CH table for each new column
        for (const col of newColumns) {
            const alterDDL = ClickHouseDDLBuilder.buildAlterAddColumn(chDb, table, cluster, col);
            logger.debug('CH ALTER TABLE DDL', { ddl: alterDDL });
            await ch.exec(alterDDL);
        }

        // 3. Read current full column list from CH system.columns (post-ALTER)
        //    This is the source of truth for rebuilding queue + MV.
        //    We do NOT parse system.tables.create_table_query — it omits ON CLUSTER.
        const currentCols = await chCurrentColumns(ch, chDb, table);

        if (currentCols.length === 0) {
            return {
                success: false,
                action: 'altered',
                table,
                details: `Could not read columns from CH system.columns for ${chDb}.${table}`,
                error: 'CH system.columns returned empty',
            };
        }

        // 4. Detect queue pattern: Pattern A (JSONEachRow, multiple columns)
        //    vs Pattern B (JSONAsString, single `message` column).
        const queueCols = await chQueueColumns(ch, chDb, table);

        if (queueCols.length === 0) {
            // Queue table exists (we just ran ALTER on the main table) but returned no columns.
            // This is abnormal — log a warning and abort rather than silently pick the wrong pattern.
            logger.warn(
                `CH sync: ${chDb}.${table}_queue returned 0 columns from system.columns — ` +
                `cannot detect Kafka format pattern; skipping queue+MV rebuild`,
            );
            return {
                success: false,
                action: 'altered',
                table,
                details: `Column(s) added to ${chDb}.${table} but queue+MV rebuild skipped: queue returned 0 columns`,
                error: 'Queue pattern detection failed: system.columns empty for queue table',
            };
        }

        const isPatternB = queueCols.length === 1 && queueCols[0].name === 'message';

        logger.info(`CH sync: detected ${isPatternB ? 'Pattern B (JSONAsString)' : 'Pattern A (JSONEachRow)'} for ${table}_queue`);

        // 4b. Extract existing Kafka config before dropping
        const existingKafkaConfig = await getKafkaQueueConfig(ch, chDb, table) || getDefaultKafkaConfig(chDb, table, kafkaCfg);

        // 5. DROP MV and Queue (order matters — MV first, queue second)
        const dropMvDDL = ClickHouseDDLBuilder.buildDropTable(chDb, `${table}_mv`, cluster);
        logger.debug('CH DROP MV', { ddl: dropMvDDL });
        await ch.exec(dropMvDDL);

        const dropQueueDDL = ClickHouseDDLBuilder.buildDropTable(chDb, `${table}_queue`, cluster);
        logger.debug('CH DROP QUEUE', { ddl: dropQueueDDL });
        await ch.exec(dropQueueDDL);

        // 6. Rebuild queue + MV using the detected pattern
        let newQueueDDL: string;
        let newMvDDL: string;

        if (isPatternB) {
            existingKafkaConfig.kafka_format = 'JSONAsString';
            newQueueDDL = ClickHouseDDLBuilder.buildQueueJsonAsString(chDb, table, cluster, existingKafkaConfig);
            newMvDDL = ClickHouseDDLBuilder.buildMvJsonAsString(chDb, table, cluster, currentCols);
        } else {
            existingKafkaConfig.kafka_format = 'JSONEachRow';
            newQueueDDL = ClickHouseDDLBuilder.buildQueue(chDb, table, cluster, currentCols, existingKafkaConfig);
            newMvDDL = ClickHouseDDLBuilder.buildMaterializedView(chDb, table, cluster, currentCols);
        }

        logger.debug('CH RECREATE QUEUE DDL', { ddl: newQueueDDL });
        await ch.exec(newQueueDDL);

        logger.debug('CH RECREATE MV DDL', { ddl: newMvDDL });
        await ch.exec(newMvDDL);

        logger.info(`CH sync: altered ${table} (+${addedColNames.join(', ')}), rebuilt queue+MV (${isPatternB ? 'Pattern B' : 'Pattern A'})`);

        return {
            success: true,
            action: 'altered',
            table,
            details: `Added column(s) [${addedColNames.join(', ')}] to ${chDb}.${table}; rebuilt ${table}_queue and ${table}_mv (${isPatternB ? 'JSONAsString' : 'JSONEachRow'})`,
        };
    }
}

export default new ClickHouseSyncService();
