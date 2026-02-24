import { Request, Response, NextFunction } from 'express';
import https from 'https';
import DatabasePools from '../config/database';
import logger from '../utils/logger';

// Strict identifier validation: schema/table names must be alphanumeric + underscores
const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function sendSlackNotification(payload: {
  user: string;
  database: string;
  tables: string[];
  publication: { name: string; success: boolean; error?: string };
  subscriptions: Array<{ cloud: string; name: string; success: boolean; error?: string }>;
}): void {
  const slackConfig = DatabasePools.getInstance().getSlackConfig();
  if (!slackConfig?.botToken || !slackConfig.channels?.length) return;

  const allSuccess = payload.publication.success && payload.subscriptions.every(s => s.success);
  const tableList = payload.tables.map(t => `\`${t}\``).join(', ');

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${allSuccess ? '\u2705' : '\u26A0\uFE0F'} Replication Update`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Database:*\n${payload.database}` },
        { type: 'mrkdwn', text: `*Triggered by:*\n${payload.user}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Tables:*\n${tableList}` },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: payload.publication.success
          ? `\u2705  *Publication* (\`${payload.publication.name}\`): Added successfully`
          : `\u274C  *Publication* (\`${payload.publication.name}\`): ${payload.publication.error}`,
      },
    },
    ...payload.subscriptions.map(s => ({
      type: 'section' as const,
      text: {
        type: 'mrkdwn' as const,
        text: s.success
          ? `\u2705  *Subscription* (\`${s.cloud}\`): Refreshed successfully`
          : `\u274C  *Subscription* (\`${s.cloud}\`): ${s.error}`,
      },
    })),
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `<!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} at {time}|${new Date().toISOString()}>` },
      ],
    },
  ];

  const fallbackText = `Replication Update — ${payload.database} by ${payload.user}`;

  for (const channel of slackConfig.channels) {
    const body = JSON.stringify({ channel, text: fallbackText, blocks });
    const req = https.request(
      {
        hostname: 'slack.com',
        path: '/api/chat.postMessage',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': `Bearer ${slackConfig.botToken}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (resp) => {
        if (resp.statusCode !== 200) {
          logger.warn('Slack notification returned non-200', { channel, status: resp.statusCode });
        }
      }
    );
    req.on('error', (err) => logger.warn('Slack notification failed', { channel, error: err.message }));
    req.write(body);
    req.end();
  }
}

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

    // Fire-and-forget Slack notification
    sendSlackNotification({
      user: (req.user as any)?.username || 'unknown',
      database: primaryDb.label || primaryDb.database,
      tables: tables.map(t => `${t.schema}.${t.table}`),
      publication: {
        name: primaryDb.publicationName,
        success: results.publication.success,
        error: results.publication.error,
      },
      subscriptions: results.subscriptions.map((s, i) => {
        const cloudName = config.secondaryClouds[i];
        const secDb = config.secondaryDatabases[cloudName]?.find(db => db.databaseName === database);
        return {
          cloud: s.cloud,
          name: secDb?.subscriptionName || 'unknown',
          success: s.success,
          error: s.error,
        };
      }),
    });
  } catch (error: any) {
    logger.error('Replication add-tables failed:', error);
    next(error);
  }
};
