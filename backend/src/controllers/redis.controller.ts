import { Request, Response, NextFunction } from 'express';
import redisManagerService from '../services/redis/RedisManagerService';
import { isWriteCommand } from '../services/redis/RedisCommandExecutor';
import RedisManagerPools from '../config/redis-pools';
import historyService from '../services/history.service';
import logger from '../utils/logger';
import { AppError } from '../middleware/error.middleware';
import { RedisCommandRequest, RedisScanRequest } from '../types';

/**
 * Execute a Redis command
 */
export const executeRedisCommand = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user as Express.User;
    const request: RedisCommandRequest = req.body;

    const pools = RedisManagerPools.getInstance();
    if (!pools.isConfigured()) {
      throw new AppError('Redis Manager is not configured', 503);
    }

    logger.info('Redis command requested', {
      user: user.email,
      command: request.command,
      cloud: request.cloud,
    });

    const result = await redisManagerService.executeCommand(request, user.role || 'READER');

    // Save write commands and RAW commands to history
    const upperCmd = request.command.toUpperCase();
    if (isWriteCommand(request.command) || upperCmd === 'RAW') {
      const cloudResults: Record<string, any> = {};
      for (const key of Object.keys(result)) {
        if (key !== 'id' && key !== 'success' && key !== 'command') {
          cloudResults[key] = {
            success: result[key]?.success,
            duration_ms: result[key]?.duration_ms,
            error: result[key]?.error,
          };
        }
      }

      historyService.saveRedisOperation(
        user.id,
        upperCmd,
        request.cloud,
        { command: upperCmd, args: request.args },
        cloudResults
      ).catch(() => {}); // fire-and-forget
    }

    res.json(result);
  } catch (error: any) {
    if (error.message?.includes('READER role') || error.message?.includes('Invalid cloud') || error.message?.includes('blocked') || error.message?.includes('Only MASTER')) {
      return res.status(403).json({ error: error.message });
    }
    next(error);
  }
};

/**
 * Start a SCAN operation
 */
export const scanKeys = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user as Express.User;
    const request: RedisScanRequest = req.body;

    const pools = RedisManagerPools.getInstance();
    if (!pools.isConfigured()) {
      throw new AppError('Redis Manager is not configured', 503);
    }

    logger.info('Redis SCAN requested', {
      user: user.email,
      pattern: request.pattern,
      cloud: request.cloud,
      action: request.action,
    });

    const { executionId } = await redisManagerService.startScan(request, user.role || 'READER');

    // Save SCAN delete to history
    if (request.action === 'delete') {
      historyService.saveRedisOperation(
        user.id,
        'SCAN_DELETE',
        request.cloud,
        { pattern: request.pattern, scanCount: request.scanCount },
        { executionId, status: 'started' }
      ).catch(() => {}); // fire-and-forget
    }

    res.json({
      executionId,
      status: 'started',
      message: 'SCAN operation started',
    });
  } catch (error: any) {
    if (error.message?.includes('READER role') || error.message?.includes('Invalid cloud') || error.message?.includes('blocked')) {
      return res.status(403).json({ error: error.message });
    }
    next(error);
  }
};

/**
 * Cancel a running SCAN operation
 */
export const cancelScan = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError('Scan execution ID is required', 400);
    }

    const cancelled = await redisManagerService.cancelScan(id);

    if (!cancelled) {
      // Could be already completed or not found
      const status = await redisManagerService.getScanStatus(id);
      if (!status) {
        throw new AppError('Scan execution not found', 404);
      }
      return res.json({
        success: true,
        message: `Scan already ${status.status}`,
      });
    }

    res.json({
      success: true,
      message: 'Cancellation requested',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get SCAN operation status
 */
export const getScanStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError('Scan execution ID is required', 400);
    }

    const status = await redisManagerService.getScanStatus(id);

    if (!status) {
      throw new AppError('Scan execution not found', 404);
    }

    res.json(status);
  } catch (error) {
    next(error);
  }
};

/**
 * Get Redis operation history
 */
export const getRedisHistory = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user as Express.User;
    const { limit, offset, user_id } = req.query;

    const history = await historyService.getRedisHistory({
      user_id: user.role === 'MASTER' && user_id ? String(user_id) : undefined,
      limit: limit ? parseInt(String(limit), 10) : 20,
      offset: offset ? parseInt(String(offset), 10) : 0,
    });

    res.json({ data: history });
  } catch (error) {
    next(error);
  }
};
