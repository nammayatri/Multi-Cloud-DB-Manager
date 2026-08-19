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
