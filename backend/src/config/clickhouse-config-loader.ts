import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

export interface ClickHouseKafkaConfig {
    brokerList: string;
    topicMiddle: string;   // e.g. "sessionizer"
    groupSuffix: string;   // e.g. "ec2-ckh-consumer"
}

export interface ClickHouseConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    cluster: string;
    kafka: ClickHouseKafkaConfig;
    selectUsers?: string[];   // users to GRANT SELECT on newly created tables
    // When true, DDL/queries that fail due to missing ZooKeeper coordination are retried
    // against a rewritten single-node (non-replicated) DDL. Intended for local/dev only —
    // must be explicitly opted into, never assumed true in production.
    allowLocalFallback?: boolean;
}

/**
 * Substitute ${ENV_VAR} placeholders in a string using process.env
 */
function substituteEnvVars(raw: string): string {
    return raw.replace(/\$\{([^}]+)\}/g, (match, varName) => {
        const value = process.env[varName];
        if (!value) {
            logger.warn(`ClickHouse config: environment variable ${varName} not found, using placeholder`);
            return match;
        }
        return value;
    });
}

/**
 * Load ClickHouse configuration.
 * Priority:
 *   1. CLICKHOUSE_CONFIGS env var (base64-encoded JSON) — set via Kubernetes Secret
 *   2. /config/clickhouse.json  (Kubernetes mount)
 *   3. backend/config/clickhouse.json  (local file)
 *
 * Returns null if no config is found (ClickHouse sync will be disabled).
 */
export function loadClickHouseConfig(): ClickHouseConfig | null {
    // 1. Base64-encoded env var (matches CLICKHOUSE_CONFIGS key in k8s/secrets.yaml)
    if (process.env.CLICKHOUSE_CONFIGS) {
        try {
            const raw = Buffer.from(process.env.CLICKHOUSE_CONFIGS, 'base64').toString('utf-8');
            const config: ClickHouseConfig = JSON.parse(substituteEnvVars(raw));
            logger.info('ClickHouse config loaded from CLICKHOUSE_CONFIGS env var');
            return config;
        } catch (err) {
            logger.error('Failed to parse CLICKHOUSE_CONFIGS env var:', err);
            throw err;
        }
    }

    // 2. Kubernetes mount
    const k8sPath = '/config/clickhouse.json';
    if (fs.existsSync(k8sPath)) {
        return loadFromFile(k8sPath);
    }

    // 3. Local file
    const localPath = path.join(__dirname, '../../config/clickhouse.json');
    if (fs.existsSync(localPath)) {
        return loadFromFile(localPath);
    }

    logger.info('No clickhouse.json found — ClickHouse sync will be disabled');
    return null;
}

function loadFromFile(filePath: string): ClickHouseConfig {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const substituted = substituteEnvVars(raw);
        const config: ClickHouseConfig = JSON.parse(substituted);
        logger.info('ClickHouse config loaded', { path: filePath, host: config.host, database: config.database });
        return config;
    } catch (err) {
        logger.error(`Failed to load ClickHouse config from ${filePath}:`, err);
        throw err;
    }
}
