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
