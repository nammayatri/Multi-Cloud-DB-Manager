import { ClickHouseKafkaConfig } from '../../config/clickhouse-config-loader';

export interface CHColumn {
    name: string;
    chType: string;      // Full CH type, e.g. "String", "Nullable(Int64)", "DateTime"
}

/**
 * The sentinel version column added to every main ReplacingMergeTree table.
 * Exported so SyncService can reference the same name without a second hardcode.
 */
export const CH_SENTINEL_COLUMN = 'date';

/**
 * Index column names that get bloom_filter indexes (if present in the table).
 * Per spec: always on `id`; also on `merchant_operating_city_id` and `merchant_id`
 * if they are present and non-nullable.
 */
const BLOOM_FILTER_COLS = new Set(['id', 'merchant_operating_city_id', 'merchant_id']);

/**
 * Builds all ClickHouse DDL strings.
 * All DDL includes ON CLUSTER '{cluster}' — it is NEVER trusted from system.tables.
 */
export class ClickHouseDDLBuilder {
    /**
     * Derive a db abbreviation from the database name.
     * atlas_driver_offer_bpp → adob (first letter of each _-separated word)
     */
    public static dbAbbrev(dbName: string): string {
        return dbName
            .split('_')
            .filter(Boolean)
            .map(w => w[0])
            .join('');
    }

    /**
     * Derive the Kafka topic name from the db name and table name.
     * e.g. db=atlas_driver_offer_bpp, table=search_request, middle=sessionizer
     *   → adob-sessionizer-searchrequest
     */
    public static topicName(dbName: string, tableName: string, topicMiddle: string): string {
        const abbrev = this.dbAbbrev(dbName);
        const tableSlug = tableName.replace(/_/g, '').replace(/\s+/g, '').toLowerCase();
        return `${abbrev}-${topicMiddle}-${tableSlug}`;
    }

    /**
     * Derive the Kafka consumer group name.
     * e.g. adob-sessionizer-searchrequest-ec2-ckh-consumer
     */
    public static groupName(dbName: string, tableName: string, kafkaCfg: ClickHouseKafkaConfig): string {
        const topic = this.topicName(dbName, tableName, kafkaCfg.topicMiddle);
        return `${topic}-${kafkaCfg.groupSuffix}`;
    }

    /**
     * Find the primary DateTime column for ORDER BY / PARTITION BY.
     * Priority: created_at → updated_at → first DateTime/Date column found → null
     */
    public static findDateTimeColumn(columns: CHColumn[]): CHColumn | null {
        const priority = ['created_at', 'updated_at'];
        for (const name of priority) {
            const col = columns.find(c => c.name === name);
            if (col && this.isDateTimeLike(col.chType)) return col;
        }
        // Any DateTime column
        return columns.find(c => this.isDateTimeLike(c.chType)) ?? null;
    }

    /**
     * Iteratively strip outermost Nullable(...) and LowCardinality(...) wrappers
     * to get the raw ClickHouse base type.
     * e.g. Nullable(LowCardinality(String)) → String
     *      Nullable(DateTime64(3))          → DateTime64(3)
     */
    private static unwrapType(chType: string): string {
        let t = chType.trim();
        const wrappers = ['Nullable(', 'LowCardinality('];
        let changed = true;
        while (changed) {
            changed = false;
            for (const w of wrappers) {
                if (t.startsWith(w) && t.endsWith(')')) {
                    t = t.slice(w.length, -1).trim();
                    changed = true;
                }
            }
        }
        return t;
    }

    private static isDateTimeLike(chType: string): boolean {
        const bare = this.unwrapType(chType);
        return bare === 'DateTime' || bare === 'Date' || bare.startsWith('DateTime64');
    }

    private static isNullable(chType: string): boolean {
        return chType.startsWith('Nullable(');
    }

    /**
     * Determine indexes for the main table.
     * - bloom_filter on `id` (always)
     * - bloom_filter on `merchant_operating_city_id` and `merchant_id` if non-nullable
     * - minmax on the primary DateTime column
     */
    private static buildIndexLines(columns: CHColumn[], dateTimeCol: CHColumn | null): string[] {
        const lines: string[] = [];
        const colMap = new Map(columns.map(c => [c.name, c]));

        for (const colName of BLOOM_FILTER_COLS) {
            const col = colMap.get(colName);
            if (!col) continue;
            // id: always; others: only if non-nullable
            if (colName === 'id' || !this.isNullable(col.chType)) {
                lines.push(`  INDEX ${colName} ${colName} TYPE bloom_filter GRANULARITY 1`);
            }
        }

        if (dateTimeCol) {
            lines.push(`  INDEX ${dateTimeCol.name} ${dateTimeCol.name} TYPE minmax GRANULARITY 1`);
        }

        return lines;
    }

    /**
     * Build ORDER BY clause.
     * - Normal: (dateTimeCol, id)
     * - Edge case (no DateTime col): all non-nullable columns
     * - Ultimate fallback: tuple()
     */
    private static buildOrderBy(columns: CHColumn[], dateTimeCol: CHColumn | null): string {
        if (dateTimeCol) {
            const idCol = columns.find(c => c.name === 'id');
            if (idCol) return `(${dateTimeCol.name}, id)`;
            return `(${dateTimeCol.name})`;
        }
        // Edge case: order by all non-nullable columns
        const nonNullable = columns.filter(c => !this.isNullable(c.chType)).map(c => c.name);
        return nonNullable.length > 0 ? `(${nonNullable.join(', ')})` : 'tuple()';
    }

    /**
     * Format a column line for the CREATE TABLE body.
     */
    private static colLine(col: CHColumn): string {
        return `  \`${col.name}\` ${col.chType}`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC DDL BUILDERS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Build the main ReplicatedReplacingMergeTree table DDL.
     */
    public static buildCreateTable(
        db: string,
        table: string,
        cluster: string,
        columns: CHColumn[],
    ): string {
        const dateTimeCol = this.findDateTimeColumn(columns);
        const partitionBy = dateTimeCol
            ? `toStartOfWeek(${dateTimeCol.name})`
            : null;
        const orderBy = this.buildOrderBy(columns, dateTimeCol);
        const indexLines = this.buildIndexLines(columns, dateTimeCol);

        const colLines = columns.map(c => this.colLine(c));
        // Always add the `date` sentinel column
        colLines.push("  `date` DateTime DEFAULT now()");

        const allDefLines = [...colLines, ...indexLines];

        const enginePath = `/clickhouse/{cluster}/tables/{shard}/${db}/${table}`;

        const lines: string[] = [
            `CREATE TABLE IF NOT EXISTS ${db}.${table} ON CLUSTER '${cluster}'`,
            `(`,
            allDefLines.join(',\n'),
            `)`,
            `ENGINE = ReplicatedReplacingMergeTree('${enginePath}', '{replica}', date)`,
        ];

        if (partitionBy) lines.push(`PARTITION BY ${partitionBy}`);

        if (dateTimeCol) {
            lines.push(`PRIMARY KEY ${dateTimeCol.name}`);
        }
        lines.push(`ORDER BY ${orderBy}`);

        if (dateTimeCol) {
            lines.push(`TTL ${dateTimeCol.name} + toIntervalDay(730)`);
        }
        lines.push(`SETTINGS index_granularity = 8192`);

        return lines.join('\n');
    }

    /**
     * Build the Kafka queue table DDL.
     * Columns: same as main table, WITHOUT the `date` sentinel column.
     */
    public static buildQueue(
        db: string,
        table: string,
        cluster: string,
        columns: CHColumn[],
        kafkaCfg: ClickHouseKafkaConfig,
    ): string {
        const topic = this.topicName(db, table, kafkaCfg.topicMiddle);
        const group = this.groupName(db, table, kafkaCfg);
        const colLines = columns.map(c => this.colLine(c)).join(',\n');

        return [
            `CREATE TABLE IF NOT EXISTS ${db}.${table}_queue ON CLUSTER '${cluster}'`,
            `(`,
            colLines,
            `)`,
            `ENGINE = Kafka`,
            `SETTINGS`,
            `  kafka_broker_list = '${kafkaCfg.brokerList}',`,
            `  kafka_topic_list = '${topic}',`,
            `  kafka_group_name = '${group}',`,
            `  kafka_format = 'JSONEachRow'`,
        ].join('\n');
    }

    /**
     * Build the Materialized View DDL.
     * Columns: same as queue (no `date` column).
     */
    public static buildMaterializedView(
        db: string,
        table: string,
        cluster: string,
        columns: CHColumn[],
    ): string {
        const colLines = columns.map(c => this.colLine(c)).join(',\n');

        return [
            `CREATE MATERIALIZED VIEW IF NOT EXISTS ${db}.${table}_mv ON CLUSTER '${cluster}'`,
            `TO ${db}.${table}`,
            `(`,
            colLines,
            `) AS`,
            `SELECT *`,
            `FROM ${db}.${table}_queue`,
        ].join('\n');
    }

    /**
     * Build ALTER TABLE ADD COLUMN DDL — with explicit ON CLUSTER.
     */
    public static buildAlterAddColumn(
        db: string,
        table: string,
        cluster: string,
        col: CHColumn,
    ): string {
        return `ALTER TABLE ${db}.${table} ON CLUSTER '${cluster}' ADD COLUMN IF NOT EXISTS \`${col.name}\` ${col.chType}`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PATTERN B: JSONAsString queue + JSONExtract MV
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Build a Kafka queue table with a single `message String` column.
     * (Pattern B — JSONAsString format)
     */
    public static buildQueueJsonAsString(
        db: string,
        table: string,
        cluster: string,
        kafkaCfg: ClickHouseKafkaConfig,
    ): string {
        const topic = this.topicName(db, table, kafkaCfg.topicMiddle);
        const group = this.groupName(db, table, kafkaCfg);

        return [
            `CREATE TABLE IF NOT EXISTS ${db}.${table}_queue ON CLUSTER '${cluster}'`,
            `(`,
            `  \`message\` String`,
            `)`,
            `ENGINE = Kafka`,
            `SETTINGS`,
            `  kafka_broker_list = '${kafkaCfg.brokerList}',`,
            `  kafka_topic_list = '${topic}',`,
            `  kafka_group_name = '${group}',`,
            `  kafka_format = 'JSONAsString'`,
        ].join('\n');
    }

    /**
     * Build a Materialized View that extracts fields from `message` using JSONExtract*.
     * (Pattern B — pairs with JSONAsString queue)
     */
    public static buildMvJsonAsString(
        db: string,
        table: string,
        cluster: string,
        columns: CHColumn[],
    ): string {
        const colDefs = columns.map(c => this.colLine(c)).join(',\n');
        const selectExprs = columns.map(c => this.jsonExtractExpr(c)).join(',\n');

        return [
            `CREATE MATERIALIZED VIEW IF NOT EXISTS ${db}.${table}_mv ON CLUSTER '${cluster}'`,
            `TO ${db}.${table}`,
            `(`,
            colDefs,
            `) AS`,
            `SELECT`,
            selectExprs,
            `FROM ${db}.${table}_queue`,
        ].join('\n');
    }

    /**
     * Generate a JSONExtract expression for a column based on its CH type.
     *
     * DateTime/Date   -> toDateTime(JSONExtractInt(message, 'col'))
     * Int types       -> JSONExtractInt(message, 'col')
     * Float/Decimal   -> JSONExtractFloat(message, 'col')
     * Array types     -> JSONExtractRaw(message, 'col')
     * String (default)-> JSONExtractString(message, 'col')
     */
    private static jsonExtractExpr(col: CHColumn): string {
        const name = col.name;
        // Use unwrapType to correctly handle nested wrappers like Nullable(LowCardinality(String))
        const bare = this.unwrapType(col.chType);

        // DateTime64 / DateTime / Date -> toDateTime(JSONExtractInt(message, 'col'))
        if (bare === 'DateTime' || bare === 'Date' || bare.startsWith('DateTime64')) {
            return `  toDateTime(JSONExtractInt(message, '${name}')) AS ${name}`;
        }

        // Integer types
        if (/^Int(8|16|32|64|128|256)$/.test(bare) || /^UInt(8|16|32|64|128|256)$/.test(bare)) {
            return `  JSONExtractInt(message, '${name}') AS ${name}`;
        }

        // Float / Decimal types
        if (/^Float(32|64)$/.test(bare) || bare.startsWith('Decimal')) {
            return `  JSONExtractFloat(message, '${name}') AS ${name}`;
        }

        // Array types -> JSONExtractRaw
        if (bare.startsWith('Array(')) {
            return `  JSONExtractRaw(message, '${name}') AS ${name}`;
        }

        // Default: String
        return `  JSONExtractString(message, '${name}') AS ${name}`;
    }

    /**
     * Build DROP TABLE DDL — with explicit ON CLUSTER.
     */
    public static buildDropTable(db: string, table: string, cluster: string): string {
        return `DROP TABLE IF EXISTS ${db}.${table} ON CLUSTER '${cluster}'`;
    }

    /**
     * Build GRANT SELECT DDL for the main table on a cluster.
     */
    public static buildGrant(db: string, table: string, cluster: string, users: string[]): string {
        const userList = users.join(', ');
        // Correct ClickHouse GRANT syntax: GRANT ON CLUSTER '<cluster>' <privilege> ON <table> TO <users>
        return `GRANT ON CLUSTER '${cluster}' SELECT ON ${db}.${table} TO ${userList}`;
    }
}

export default ClickHouseDDLBuilder;
