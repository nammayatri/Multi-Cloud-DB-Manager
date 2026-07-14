import { Request, Response, NextFunction } from 'express';
import DatabasePools from '../config/database';
import logger from '../utils/logger';

/**
 * Get full database configuration
 */
export const getConfiguration = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const dbPools = DatabasePools.getInstance();
    const config = dbPools.getCloudConfig();

    // Accurate per-database view with per-cloud roles (source of truth for the
    // UI). Each database names its own primary cloud; the primary/secondary
    // blocks below are kept for backward compatibility with older clients.
    const allDbInfos = [
      ...config.primaryDatabases,
      ...Object.values(config.secondaryDatabases).flat(),
    ];
    const databasesByName: Record<string, any> = {};
    for (const [name, clouds] of Object.entries(config.databaseClouds)) {
      const primaryCloud = config.databasePrimaryCloud[name];
      databasesByName[name] = {
        clouds: clouds
          .map(cloudType => {
            const info = allDbInfos.find(d => d.databaseName === name && d.cloudType === cloudType);
            if (!info) return null;
            const role = cloudType === primaryCloud ? 'primary' : 'secondary';
            return {
              cloudType,
              role,
              label: info.label,
              schemas: info.schemas,
              defaultSchema: info.defaultSchema,
              ...(info.publicationName && { publicationName: info.publicationName }),
              ...(info.subscriptionName && { subscriptionName: info.subscriptionName }),
            };
          })
          .filter(Boolean),
      };
    }

    // Return sanitized configuration (without passwords)
    res.json({
      databasesByName,
      primary: {
        cloudName: config.primaryCloud,
        databases: config.primaryDatabases.map(db => ({
          name: db.databaseName,
          label: db.label,
          cloudType: db.cloudType,
          schemas: db.schemas,
          defaultSchema: db.defaultSchema,
          ...(db.publicationName && { publicationName: db.publicationName }),
        }))
      },
      secondary: config.secondaryClouds.map(cloudName => ({
        cloudName,
        databases: config.secondaryDatabases[cloudName].map(db => ({
          name: db.databaseName,
          label: db.label,
          cloudType: db.cloudType,
          schemas: db.schemas,
          defaultSchema: db.defaultSchema,
          ...(db.subscriptionName && { subscriptionName: db.subscriptionName }),
        }))
      }))
    });
  } catch (error: any) {
    logger.error('Failed to fetch configuration:', error);
    next(error);
  }
};

/**
 * Get available schemas for a database (backward compatibility)
 */
export const getSchemas = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { database } = req.params; // 'primary' or 'secondary' (legacy) or database name
    const { cloud } = req.query;

    const dbPools = DatabasePools.getInstance();
    const cloudProvider = (cloud as string) || dbPools.getCloudConfig().primaryCloud || 'gcp';

    // Try to get schema info directly by cloud and database name
    let schemaInfo = dbPools.getSchemaInfo(cloudProvider, database);

    // If not found, try legacy mapping (primary -> bpp, secondary -> bap)
    if (!schemaInfo) {
      if (database === 'primary') {
        schemaInfo = dbPools.getSchemaInfo(cloudProvider, 'bpp');
      } else if (database === 'secondary') {
        schemaInfo = dbPools.getSchemaInfo(cloudProvider, 'bap');
      }
    }

    if (!schemaInfo) {
      return res.status(404).json({
        error: `Database not found: ${database} in cloud: ${cloudProvider}`
      });
    }

    // If schemas are pre-configured (from JSON), return them
    if (schemaInfo.schemas.length > 0) {
      return res.json({
        schemas: schemaInfo.schemas,
        default: schemaInfo.defaultSchema
      });
    }

    // Fall back to querying the database for schemas (for backward compatibility)
    logger.info('Schemas not pre-configured, querying database', {
      cloud: cloudProvider,
      database
    });

    const pool = dbPools.getPoolByName(cloudProvider, schemaInfo.databaseName);
    if (!pool) {
      return res.status(404).json({
        error: `Database pool not found: ${cloudProvider}_${schemaInfo.databaseName}`
      });
    }

    const result = await pool.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_toast', 'pg_catalog', 'information_schema', 'tiger', 'tiger_data', 'topology', 'public')
      ORDER BY schema_name
    `);

    const schemas = result.rows.map(row => row.schema_name);

    res.json({
      schemas,
      default: schemaInfo.defaultSchema
    });
  } catch (error: any) {
    logger.error('Failed to fetch schemas:', error);
    next(error);
  }
};
