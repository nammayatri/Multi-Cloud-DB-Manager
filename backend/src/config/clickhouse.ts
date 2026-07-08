import { createClient, ClickHouseClient } from '@clickhouse/client';
import logger from '../utils/logger';
import { loadClickHouseConfig, ClickHouseConfig } from './clickhouse-config-loader';

/**
 * Singleton ClickHouse client manager.
 * Mirrors the DatabasePools singleton pattern.
 * Returns null from getInstance() if no clickhouse.json is configured.
 */
class ClickHouseClientManager {
    private static instance: ClickHouseClientManager | null = null;
    private static initialized = false;

    private client: ClickHouseClient;
    public readonly config: ClickHouseConfig;
    /** Explicit opt-in gate for the ZooKeeper-error → single-node DDL rewrite fallback (local/dev only). */
    private readonly allowLocalFallback: boolean;

    private constructor(config: ClickHouseConfig) {
        this.config = config;
        this.allowLocalFallback = config.allowLocalFallback === true;
        this.client = createClient({
            host: `http://${config.host}:${config.port}`,
            username: config.user,
            password: config.password,
            database: config.database,
            request_timeout: 30_000,
            compression: { response: true, request: false },
            clickhouse_settings: {
                async_insert: 0,
            },
        });
        logger.info('ClickHouse client created', {
            host: config.host,
            port: config.port,
            database: config.database,
        });
    }

    public static getInstance(): ClickHouseClientManager | null {
        if (!ClickHouseClientManager.initialized) {
            ClickHouseClientManager.initialized = true;
            try {
                const config = loadClickHouseConfig();
                if (!config) {
                    logger.info('ClickHouse sync disabled — no configuration found');
                    return null;
                }
                ClickHouseClientManager.instance = new ClickHouseClientManager(config);
            } catch (err) {
                logger.error('Failed to initialize ClickHouse client:', err);
                return null;
            }
        }
        return ClickHouseClientManager.instance;
    }

    /**
     * Execute a raw DDL or query string against ClickHouse.
     * If `config.allowLocalFallback` is enabled and ZooKeeper configuration is missing
     * (e.g., local single-node test), rewrites DDL to non-replicated standard MergeTree
     * engines and drops ON CLUSTER. Disabled by default — must be explicitly opted into,
     * since ZooKeeper errors can also be a transient failure on a real production cluster.
     */
    public async exec(query: string): Promise<void> {
        logger.debug('CH exec:', { query: query.slice(0, 200) });
        try {
            await this.client.exec({ query });
        } catch (err: any) {
            if (this.allowLocalFallback && err.message && (err.message.includes('Zookeeper') || err.message.includes('ZooKeeper') || err.code === '139')) {
                const rewritten = rewriteQueryForLocal(query);
                logger.info('Retrying DDL exec with rewritten local DDL', { original: query.slice(0, 100), rewritten: rewritten.slice(0, 100) });
                await this.client.exec({ query: rewritten });
                return;
            }
            throw err;
        }
    }

    /**
     * Run a SELECT and return rows as an array of objects.
     */
    public async query<T = Record<string, unknown>>(query: string): Promise<T[]> {
        logger.debug('CH query:', { query: query.slice(0, 200) });
        try {
            const result = await this.client.query({ query, format: 'JSONEachRow' });
            return result.json<T>();
        } catch (err: any) {
            if (this.allowLocalFallback && err.message && (err.message.includes('Zookeeper') || err.message.includes('ZooKeeper') || err.code === '139')) {
                const rewritten = rewriteQueryForLocal(query);
                logger.info('Retrying query with rewritten local DDL', { original: query.slice(0, 100), rewritten: rewritten.slice(0, 100) });
                const result = await this.client.query({ query: rewritten, format: 'JSONEachRow' });
                return result.json<T>();
            }
            throw err;
        }
    }

    /**
     * Run a SELECT and return rows + column metadata.
     * Used by the user-facing query endpoint where the UI needs column names/types.
     */
    public async queryWithMeta(query: string): Promise<{
        rows: Array<Record<string, unknown>>;
        meta: Array<{ name: string; type: string }>;
    }> {
        logger.debug('CH queryWithMeta:', { query: query.slice(0, 200) });
        try {
            const result = await this.client.query({ query, format: 'JSON' });
            const json = await result.json<any>();
            return { rows: json.data ?? [], meta: json.meta ?? [] };
        } catch (err: any) {
            if (this.allowLocalFallback && err.message && (err.message.includes('Zookeeper') || err.message.includes('ZooKeeper') || err.code === '139')) {
                const rewritten = rewriteQueryForLocal(query);
                logger.info('Retrying queryWithMeta with rewritten local DDL', { original: query.slice(0, 100), rewritten: rewritten.slice(0, 100) });
                const result = await this.client.query({ query: rewritten, format: 'JSON' });
                const json = await result.json<any>();
                return { rows: json.data ?? [], meta: json.meta ?? [] };
            }
            throw err;
        }
    }

    /**
     * Ping ClickHouse — returns true if reachable.
     */
    public async ping(): Promise<boolean> {
        try {
            const ok = await this.client.ping();
            return ok.success;
        } catch {
            return false;
        }
    }

    public async shutdown(): Promise<void> {
        await this.client.close();
        logger.info('ClickHouse client closed');
    }
}

/**
 * Helper to rewrite clustered/replicated DDLs to run locally without ZooKeeper.
 */
function rewriteQueryForLocal(query: string): string {
    // 1. Remove ON CLUSTER '<cluster>'
    let rewritten = query.replace(/\s+ON\s+CLUSTER\s+'[^']+'/gi, '');
    rewritten = rewritten.replace(/\s+ON\s+CLUSTER\s+"[^"]+"/gi, '');
    rewritten = rewritten.replace(/\s+ON\s+CLUSTER\s+\S+/gi, '');

    // 2. Replace ReplicatedReplacingMergeTree(...) with ReplacingMergeTree(date)
    rewritten = rewritten.replace(
        /ENGINE\s*=\s*ReplicatedReplacingMergeTree\s*\([^,]+,\s*[^,]+,\s*([^)]+)\)/gi,
        'ENGINE = ReplacingMergeTree($1)'
    );

    // 3. Replace ReplicatedMergeTree(...) with MergeTree()
    rewritten = rewritten.replace(
        /ENGINE\s*=\s*ReplicatedMergeTree\s*\([^,]+,\s*[^)]+\)/gi,
        'ENGINE = MergeTree()'
    );

    // 4. Replace GRANT ON CLUSTER ...
    rewritten = rewritten.replace(
        /GRANT\s+ON\s+CLUSTER\s+'[^']+'\s+/gi,
        'GRANT '
    );
    rewritten = rewritten.replace(
        /GRANT\s+ON\s+CLUSTER\s+"[^"]+"\s+/gi,
        'GRANT '
    );
    rewritten = rewritten.replace(
        /GRANT\s+ON\s+CLUSTER\s+\S+\s+/gi,
        'GRANT '
    );

    return rewritten;
}

export default ClickHouseClientManager;

