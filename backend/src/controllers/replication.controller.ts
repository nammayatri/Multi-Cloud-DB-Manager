import { Request, Response, NextFunction } from 'express';
import DatabasePools from '../config/database';
import logger from '../utils/logger';

// Strict identifier validation: schema/table names must be alphanumeric + underscores
const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

interface TableRef {
  schema: string;
  table: string;
}

/**
 * Add tables to logical replication (publication + subscription refresh)
 * POST /api/replication/add-tables
 */
export const addTables = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { tables, database } = req.body as { tables: TableRef[]; database: string };

    if (!tables || !Array.isArray(tables) || tables.length === 0) {
      return res.status(400).json({ error: 'tables array is required and must not be empty' });
    }

    if (!database || typeof database !== 'string') {
      return res.status(400).json({ error: 'database name is required' });
    }

    // Validate all identifiers
    for (const t of tables) {
      if (!t.schema || !IDENTIFIER_REGEX.test(t.schema)) {
        return res.status(400).json({ error: `Invalid schema name: ${t.schema}` });
      }
      if (!t.table || !IDENTIFIER_REGEX.test(t.table)) {
        return res.status(400).json({ error: `Invalid table name: ${t.table}` });
      }
    }

    const dbPools = DatabasePools.getInstance();
    const config = dbPools.getCloudConfig();

    // Find primary database info
    const primaryDb = config.primaryDatabases.find(db => db.databaseName === database);
    if (!primaryDb) {
      return res.status(404).json({ error: `Database '${database}' not found in primary cloud` });
    }

    if (!primaryDb.publicationName) {
      return res.status(400).json({ error: `No publication configured for database '${database}'` });
    }

    // Validate publication name
    if (!IDENTIFIER_REGEX.test(primaryDb.publicationName)) {
      return res.status(400).json({ error: 'Invalid publication name in configuration' });
    }

    const results: {
      publication: { success: boolean; error?: string };
      subscriptions: Array<{ cloud: string; success: boolean; error?: string }>;
    } = {
      publication: { success: false },
      subscriptions: [],
    };

    // Build qualified table list for SQL
    const qualifiedTables = tables.map(t => `"${t.schema}"."${t.table}"`).join(', ');

    // 1. ALTER PUBLICATION on primary
    const primaryPool = dbPools.getPoolByName(config.primaryCloud, database);
    if (!primaryPool) {
      return res.status(500).json({ error: `No pool found for primary cloud database '${database}'` });
    }

    try {
      const pubSql = `ALTER PUBLICATION "${primaryDb.publicationName}" ADD TABLE ${qualifiedTables}`;
      logger.info('Executing publication ALTER', { sql: pubSql, user: (req.user as any)?.username });
      await primaryPool.query(pubSql);
      results.publication = { success: true };
    } catch (err: any) {
      logger.error('Failed to alter publication', { error: err.message });
      results.publication = { success: false, error: err.message };
    }

    // 2. Refresh subscriptions on each secondary cloud
    for (const cloudName of config.secondaryClouds) {
      const secondaryDbs = config.secondaryDatabases[cloudName];
      const secondaryDb = secondaryDbs?.find(db => db.databaseName === database);

      if (!secondaryDb?.subscriptionName) {
        results.subscriptions.push({
          cloud: cloudName,
          success: false,
          error: 'No subscription configured',
        });
        continue;
      }

      if (!IDENTIFIER_REGEX.test(secondaryDb.subscriptionName)) {
        results.subscriptions.push({
          cloud: cloudName,
          success: false,
          error: 'Invalid subscription name in configuration',
        });
        continue;
      }

      const secondaryPool = dbPools.getPoolByName(cloudName, database);
      if (!secondaryPool) {
        results.subscriptions.push({
          cloud: cloudName,
          success: false,
          error: `No pool found for ${cloudName}`,
        });
        continue;
      }

      try {
        const subSql = `ALTER SUBSCRIPTION "${secondaryDb.subscriptionName}" REFRESH PUBLICATION WITH (copy_data = false)`;
        logger.info('Executing subscription refresh', { sql: subSql, cloud: cloudName, user: (req.user as any)?.username });
        await secondaryPool.query(subSql);
        results.subscriptions.push({ cloud: cloudName, success: true });
      } catch (err: any) {
        logger.error('Failed to refresh subscription', { cloud: cloudName, error: err.message });
        results.subscriptions.push({ cloud: cloudName, success: false, error: err.message });
      }
    }

    const overallSuccess = results.publication.success && results.subscriptions.every(s => s.success);

    res.json({
      success: overallSuccess,
      results,
    });
  } catch (error: any) {
    logger.error('Replication add-tables failed:', error);
    next(error);
  }
};
