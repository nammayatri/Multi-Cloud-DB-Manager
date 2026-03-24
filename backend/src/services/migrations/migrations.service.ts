import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import logger from '../../utils/logger';
import {
  AnalysisResult,
  MigrationFileResult,
  MigrationStatement,
  MigrationsConfig,
  MigrationEnvironmentConfig,
  PathMapping,
} from '../../types/migrations';
import { getChangedFiles, getFileContent, pullLatest } from './git.service';
import { splitStatements, classifyStatement } from './sql-parser.service';
import { verifyStatement } from './verification.service';

/**
 * Load migrations config from databases.json.
 */
function loadConfig(): { migrations: MigrationsConfig; environments: Record<string, MigrationEnvironmentConfig> } {
  const candidates = [
    '/config/databases.json',
    path.join(__dirname, '../../../config/databases.json'),
  ];

  let raw: string | null = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      raw = fs.readFileSync(p, 'utf-8');
      break;
    }
  }

  if (!raw) {
    throw new Error('databases.json not found — cannot load migration config');
  }

  const substituted = raw.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const value = process.env[varName];
    return value ?? match;
  });

  const json = JSON.parse(substituted);

  if (!json.migrations) {
    throw new Error('Missing "migrations" section in databases.json');
  }

  const environments: Record<string, MigrationEnvironmentConfig> = json.readReplicas?.environments ?? {};

  return {
    migrations: json.migrations as MigrationsConfig,
    environments,
  };
}

/**
 * Find the best matching pathMapping for a file path.
 * Matches the longest prefix path.
 */
function findPathMapping(filePath: string, pathMappings: PathMapping[]): PathMapping | null {
  let bestMatch: PathMapping | null = null;
  let bestLength = 0;

  for (const mapping of pathMappings) {
    if (filePath.startsWith(mapping.path + '/') && mapping.path.length > bestLength) {
      bestMatch = mapping;
      bestLength = mapping.path.length;
    }
  }

  return bestMatch;
}

/**
 * Create a read-only pool for a migration replica database.
 */
function createReadOnlyPool(dbConfig: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}): Pool {
  const isLocalhost = dbConfig.host === 'localhost' || dbConfig.host === '127.0.0.1';

  return new Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    ...(isLocalhost ? {} : { ssl: { rejectUnauthorized: false } }),
    max: 3,
    statement_timeout: 15000,
    application_name: 'dual-db-manager-migrations',
    options: '-c default_transaction_read_only=on',
  });
}

/**
 * Compute file-level status from individual statement statuses.
 */
function computeFileStatus(statements: MigrationStatement[]): MigrationFileResult['status'] {
  if (statements.length === 0) return 'applied';

  const statuses = statements.map(s => s.status);

  if (statuses.some(s => s === 'error')) return 'error';

  const meaningful = statuses.filter(s => s !== 'skipped');
  if (meaningful.length === 0) return 'applied';

  if (meaningful.some(s => s === 'manual_check')) return 'manual_check';
  if (meaningful.every(s => s === 'applied')) return 'applied';
  if (meaningful.every(s => s === 'pending')) return 'pending';
  return 'partial';
}

/**
 * Run the full migration analysis pipeline.
 */
export async function analyze(
  fromRef: string,
  toRef: string,
  environment: string,
  databaseFilter?: string
): Promise<AnalysisResult> {
  const { migrations: config, environments } = loadConfig();

  // Fetch latest from remote before analysis
  pullLatest(config.repoPath);

  const envConfig = environments[environment];
  if (!envConfig) {
    throw new Error(`Unknown environment: "${environment}". Available: ${Object.keys(environments).join(', ')}`);
  }

  // 1. Get ALL changed files from git (no path scoping — we match against pathMapping)
  const changedFiles = getChangedFiles(config.repoPath, undefined, fromRef, toRef);

  logger.info('Migration analysis started', {
    fromRef,
    toRef,
    environment,
    totalChangedFiles: changedFiles.length,
  });

  // 2. Process each file
  const fileResults: MigrationFileResult[] = [];
  const poolCache: Map<string, Pool> = new Map();

  try {
    for (const filePath of changedFiles) {
      const filename = path.basename(filePath);

      // Find matching path mapping
      const mapping = findPathMapping(filePath, config.pathMapping);

      if (!mapping) {
        // File doesn't match any known migration path — skip silently
        continue;
      }

      // Extract folder relative to the mapping path
      const relativePath = filePath.substring(mapping.path.length + 1);
      const folder = mapping.label || mapping.path;

      // Apply database filter
      if (databaseFilter && mapping.database !== databaseFilter) {
        continue;
      }

      // Find matching DB config in this environment
      const dbConfig = envConfig.databases.find(db => db.name === mapping.database);
      if (!dbConfig) {
        fileResults.push({
          path: filePath,
          folder,
          filename,
          status: 'error',
          content: '',
          statements: [{
            sql: '',
            type: 'OTHER',
            operation: 'CONFIG',
            objectName: mapping.database,
            status: 'error',
            details: `Database "${mapping.database}" not configured in environment "${environment}"`,
          }],
          targetDatabase: mapping.database,
          migrationGroup: mapping.label,
        });
        continue;
      }

      // Get file content
      let content: string;
      try {
        content = getFileContent(config.repoPath, toRef, filePath);
      } catch (err: any) {
        fileResults.push({
          path: filePath,
          folder,
          filename,
          status: 'error',
          content: '',
          statements: [{
            sql: '',
            type: 'OTHER',
            operation: 'GIT',
            objectName: filePath,
            status: 'error',
            details: `Failed to read file: ${err.message}`,
          }],
          targetDatabase: mapping.database,
          migrationGroup: mapping.label,
        });
        continue;
      }

      // Non-SQL files: show content but skip verification
      const isSqlFile = filename.endsWith('.sql');
      if (!isSqlFile) {
        fileResults.push({
          path: filePath,
          folder,
          filename,
          status: 'manual_check',
          content,
          statements: [{
            sql: content,
            type: 'OTHER',
            operation: 'NON-SQL FILE',
            objectName: filename,
            status: 'manual_check',
            details: `Non-SQL file (${path.extname(filename) || 'no extension'}) — manual review needed`,
          }],
          targetDatabase: mapping.database,
          migrationGroup: mapping.label,
        });
        continue;
      }

      // Parse SQL statements
      const rawStatements = splitStatements(content);
      const parsedStatements = rawStatements.map(sql => classifyStatement(sql, mapping.defaultSchema));

      // Get or create pool
      const poolKey = `${mapping.database}_${environment}`;
      if (!poolCache.has(poolKey)) {
        poolCache.set(poolKey, createReadOnlyPool(dbConfig));
      }
      const pool = poolCache.get(poolKey)!;

      // Verify each statement
      const verifiedStatements: MigrationStatement[] = [];
      const client = await pool.connect();
      try {
        for (const parsed of parsedStatements) {
          const result = await verifyStatement(client, parsed, mapping.defaultSchema);
          verifiedStatements.push(result);
        }
      } finally {
        client.release();
      }

      const fileStatus = computeFileStatus(verifiedStatements);

      fileResults.push({
        path: filePath,
        folder,
        filename,
        status: fileStatus,
        content,
        statements: verifiedStatements,
        targetDatabase: mapping.database,
        migrationGroup: mapping.label,
      });
    }

    // Compute summary from ALL statements (before filtering)
    const allStatements = fileResults.flatMap(f => f.statements);
    const summary = {
      totalFiles: fileResults.length,
      totalStatements: allStatements.length,
      applied: allStatements.filter(s => s.status === 'applied').length,
      pending: allStatements.filter(s => s.status === 'pending').length,
      manualCheck: allStatements.filter(s => s.status === 'manual_check').length,
      skipped: allStatements.filter(s => s.status === 'skipped').length,
      errors: allStatements.filter(s => s.status === 'error').length,
    };

    // Strip applied/skipped statements from response to reduce payload size.
    // Only send pending, manual_check, and error statements.
    // Also skip files that are fully applied (no actionable statements).
    const actionableFiles = fileResults
      .map(f => {
        const actionableStatements = f.statements.filter(
          s => s.status !== 'applied' && s.status !== 'skipped'
        );
        return {
          ...f,
          content: '', // Don't send file content in list — use /file endpoint
          statements: actionableStatements,
          appliedCount: f.statements.length - actionableStatements.length,
        };
      })
      .filter(f => f.statements.length > 0 || f.status === 'error');

    logger.info('Migration analysis complete', {
      summary,
      matchedFiles: fileResults.length,
      actionableFiles: actionableFiles.length,
      totalChangedFiles: changedFiles.length,
    });

    return {
      success: true,
      fromRef,
      toRef,
      environment,
      summary,
      files: actionableFiles,
    };
  } finally {
    for (const [key, pool] of poolCache.entries()) {
      try {
        await pool.end();
      } catch (err: any) {
        logger.warn(`Failed to close migration pool ${key}`, { error: err.message });
      }
    }
  }
}

/**
 * Get available configuration (environments + databases + path mappings, no secrets).
 */
export function getConfig(): {
  environments: Record<string, { label: string; databases: { name: string; label: string; database: string }[] }>;
  pathMapping: Array<{ path: string; database: string; defaultSchema: string; label: string }>;
  repoPath: string;
} {
  const { migrations: config, environments } = loadConfig();

  const safeEnvs: Record<string, { label: string; databases: { name: string; label: string; database: string }[] }> = {};
  for (const [envName, envConfig] of Object.entries(environments)) {
    safeEnvs[envName] = {
      label: envConfig.label,
      databases: envConfig.databases.map(db => ({
        name: db.name,
        label: db.label,
        database: db.database,
      })),
    };
  }

  return {
    environments: safeEnvs,
    pathMapping: config.pathMapping,
    repoPath: config.repoPath,
  };
}
