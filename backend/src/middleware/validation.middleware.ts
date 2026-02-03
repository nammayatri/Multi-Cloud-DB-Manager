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

// Query history filter schema
export const queryHistorySchema = z.object({
  database: z.string().optional(), // Filter by database name
  success: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
});
