import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Global error handler middleware
 */
export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const statusCode = (err as AppError).statusCode || 500;
  const message = err.message || 'Internal Server Error';

  logger.error('Error occurred:', {
    error: message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    user: req.user?.email,
  });

  // Don't expose internal error details in production
  const response = {
    error: statusCode >= 500 && process.env.NODE_ENV === 'production' ? 'Internal Server Error' : message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  };

  res.status(statusCode).json(response);
};

/**
 * 404 handler
 */
export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
};
