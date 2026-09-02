import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema } from 'zod';
import { AppError } from './error.middleware';

/**
 * Validate request body against Zod schema
 */
export const validate = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors = error.errors.map((err) => ({
          field: err.path.join('.'),
          message: err.message,
        }));

        return res.status(400).json({
          error: 'Validation Error',
          details: errors,
        });
      }

      next(error);
    }
  };
};

// Query execution request schema
export const queryExecutionSchema = z.object({
  query: z.string().min(1, 'Query cannot be empty'),
  database: z.string().min(1, 'Database name is required'), // Dynamic database name (e.g., 'bpp', 'bap')
  mode: z.string().min(1, 'Execution mode is required'), // Dynamic cloud mode ('both' or cloud name)
  timeout: z.number().int().positive().optional(),
  pgSchema: z.string().optional(),
});

// Query request (approval workflow) schemas.
//
// A request is always a list of queries — of length one in the common case —
// so the backend has a single creation shape and never branches on "grouped or
// not". Each item carries its own target, which is what a multi-statement
// query can't express.
//
// The reason is required but not length-policed: it is the first thing an
// approver reads, and the permanent audit record for approved SELECTs, which
// query_history skips. A CHECK constraint on the column backstops the
// non-empty requirement against direct API calls.
export const queryRequestCreateSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Please explain why this needs to run')
    .max(1000, 'Reason is too long (max 1000 characters)'),
  items: z
    .array(
      z.object({
        query: z.string().min(1, 'Query cannot be empty'),
        database: z.string().min(1, 'Database name is required'),
        mode: z.string().min(1, 'Execution mode is required'),
        pgSchema: z.string().optional(),
        continueOnError: z.boolean().optional(),
      })
    )
    .min(1, 'At least one query is required')
    .max(25, 'Too many queries in one request (max 25)'),
});

// Revising the SQL of a still-pending query. The target database and cloud
// aren't editable here — changing those means starting from the console again —
// and neither is the reason, which is request-scoped and has its own endpoint.
export const queryRequestUpdateSchema = z.object({
  query: z.string().min(1, 'Query cannot be empty'),
  continueOnError: z.boolean().optional(),
});

// Changing the reason, which belongs to the request rather than one query.
export const queryRequestReasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Please explain why this needs to run')
    .max(1000, 'Reason is too long (max 1000 characters)'),
});

export const queryRequestApproveSchema = z.object({
  // Required only for ALTER/DROP — enforced in the controller, which knows the
  // stored query. Optional here so ordinary approvals need no password.
  password: z.string().optional(),
  reviewNote: z.string().max(1000, 'Note is too long (max 1000 characters)').optional(),
  // The query hash the approver had on screen. The controller rejects the
  // approval if the requester amended it in the meantime.
  expectedHash: z.string().optional(),
});

export const queryRequestRejectSchema = z.object({
  // A rejection without a reason is useless to the requester.
  reviewNote: z
    .string()
    .trim()
    .min(3, 'Please say why you are rejecting this request')
    .max(1000, 'Note is too long (max 1000 characters)'),
});

// Redis command execution schema
export const redisCommandSchema = z.object({
  command: z.string().min(1, 'Command is required'),
  args: z.record(z.any()).default({}),
  cloud: z.string().min(1, 'Cloud is required'),
  service: z.string().min(1).optional(), // Defaults to 'main' if omitted
});

// Redis SCAN schema
export const redisScanSchema = z.object({
  pattern: z.string().min(1, 'Pattern is required'),
  cloud: z.string().min(1, 'Cloud is required'),
  action: z.enum(['preview', 'delete']),
  scanCount: z.number().int().positive().max(200000).optional(),
  service: z.string().min(1).optional(),
});

// CSV batch query execution schema
export const csvBatchSchema = z.object({
  queryTemplate: z.string().min(1, 'Query template cannot be empty'),
  ids: z.array(z.string()).min(1, 'IDs array cannot be empty').max(500000, 'Too many IDs (max 500,000)'),
  database: z.string().min(1, 'Database name is required'),
  batchSize: z.number().int().positive().max(10000).optional(),
  sleepMs: z.number().int().nonnegative().max(60000).optional(),
  dryRun: z.boolean().optional(),
  stopOnError: z.boolean().optional(),
  pgSchema: z.string().optional(),
});

// ClickHouse ad-hoc query schema
export const clickhouseQuerySchema = z.object({
  query: z.string().min(1, 'Query cannot be empty'),
});

// Query history filter schema
export const queryHistorySchema = z.object({
  database: z.string().optional(), // Filter by database name
  success: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
});

// ---------------------------------------------------------------------------
// Config Replicate
//
// The identifier regex is defence in depth, not the actual guard: every schema,
// table and column name is additionally checked against what information_schema
// returned for that exact table before it reaches a quoted identifier.
// ---------------------------------------------------------------------------
const CONFIG_REPLICATE_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const identifier = (label: string) =>
  z.string().trim().min(1).max(200).regex(CONFIG_REPLICATE_IDENT, `Invalid ${label}`);

const columnClassEnum = z.enum([
  'DIMENSION',
  'MATCH_KEY',
  'GENERATED',
  'TIMESTAMP',
  'COPIED',
  'IGNORED',
]);

export const configReplicateGroupSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  // A dimension can span several columns — "this merchant, in this city".
  dimensionColumns: z.array(identifier('dimension column')).min(1).max(8),
  tables: z
    .array(
      z.object({
        schema: identifier('schema name'),
        table: identifier('table name'),
        // Positionally aligned with the group's dimension columns; a table may
        // spell the same dimension differently.
        dimensionColumns: z.array(identifier('dimension column')).min(1).max(8),
        position: z.number().int().min(0),
        matchStrategy: z.enum(['AUTO', 'UNIQUE_KEY', 'SIMILARITY']),
        matchKeyColumns: z.array(identifier('match column')).default([]),
        columnConfig: z.record(columnClassEnum).default({}),
        // { "<column>": "<schema>.<table>" } — the parent whose regenerated id
        // this column must be rewritten to.
        fkRemap: z.record(z.string().trim().min(1).max(401)).default({}),
      })
    )
    .min(1, 'A group needs at least one table')
    .max(50),
}).superRefine((group, ctx) => {
  group.tables.forEach((table, index) => {
    if (table.dimensionColumns.length !== group.dimensionColumns.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tables', index, 'dimensionColumns'],
        message:
          `${table.schema}.${table.table} must name exactly ${group.dimensionColumns.length} ` +
          'dimension column(s), in the same order as the group',
      });
    }
  });
});

export const configReplicateIntrospectTablesSchema = z.object({
  database: z.string().min(1),
  cloud: z.string().min(1),
  dimensionColumns: z.array(identifier('dimension column')).max(20).optional(),
});

export const configReplicateIntrospectTableSchema = z.object({
  database: z.string().min(1),
  cloud: z.string().min(1),
  schema: identifier('schema name'),
  table: identifier('table name'),
  dimensionColumns: z.array(identifier('dimension column')).min(1).max(8),
});

const replicateTarget = {
  groupId: z.string().uuid(),
  database: z.string().min(1),
  cloud: z.string().min(1),
  // Positionally aligned with the group's dimension columns. Arity against the
  // group is checked in the controller, which has the group loaded.
  baseValues: z.array(z.string().min(1).max(500)).min(1).max(8),
  newValues: z.array(z.string().min(1).max(500)).min(1).max(8),
};

export const configReplicateAnalyzeSchema = z
  .object(replicateTarget)
  .refine(v => v.baseValues.join('\u0000') !== v.newValues.join('\u0000'), {
    message: 'Base and new dimension values must differ in at least one column',
    path: ['newValues'],
  });

// ---------------------------------------------------------------------------
// Config Sync — wraps nammayatri's config_transfer.py export/patch commands.
// No env fields here at all — which environment a run means is resolved
// entirely server-side from CONFIG_SYNC_ALLOWED_ENVS (per review: env
// selection is not a client concern). Identifier shape mirrors the python
// script's own table-name conventions; the service layer re-validates
// independently before ever touching the subprocess argv.
// ---------------------------------------------------------------------------
const configSyncIdentifier = z.string().trim().regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, and underscores are allowed');

// Shown to whoever picks a version in the test dashboard later — required
// whenever s3 is set (every real run, now that the UI always pushes),
// enforced again server-side in configTransfer.service.ts's buildPatchStep.
const versionDescriptionSchema = z.string().trim().min(1, 'A version description is required').max(500).optional();

// The single combined export+patch flow — the only way to trigger a run.
export const configSyncExportAndPatchSchema = z.object({
  schemas: z.array(configSyncIdentifier).max(20).optional(),
  tables: z.array(configSyncIdentifier).max(50).optional(),
  parallel: z.number().int().min(1).max(16).optional(),
  s3: z.boolean().optional(),
  versionDescription: versionDescriptionSchema,
});

// config.json / patches.json, now owned by DB Manager's own Postgres and
// edited via the UI instead of being static files in the nammayatri repo.
export const configSyncAssetUpdateSchema = z.object({
  content: z.record(z.any()),
});

export const configReplicateApplySchema = z
  .object({
    ...replicateTarget,
    analysisToken: z.string().min(1).max(128),
    selections: z
      .array(
        z.object({
          diffId: z.string().min(1).max(64),
          operation: z.enum(['INSERT', 'UPDATE', 'DELETE']),
          sourceHash: z.string().max(64).nullable(),
          targetHash: z.string().max(64).nullable(),
          excludeColumns: z.array(identifier('column')).max(200).optional(),
          overrides: z.record(z.string().max(100000).nullable()).optional(),
        })
      )
      .min(1, 'Select at least one row to apply')
      .max(20000),
  })
  .refine(v => v.baseValues.join('\u0000') !== v.newValues.join('\u0000'), {
    message: 'Base and new dimension values must differ in at least one column',
    path: ['newValues'],
  });
