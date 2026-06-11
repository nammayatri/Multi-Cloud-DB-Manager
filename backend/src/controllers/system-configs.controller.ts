import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import systemConfigsService from '../services/systemConfigs/SystemConfigsService';
import SystemConfigsConfig from '../config/system-configs-config-loader';
import DatabasePools from '../config/database';
import historyService from '../services/history.service';
import logger from '../utils/logger';
import { AppError } from '../middleware/error.middleware';
import { SystemConfigExecuteRequest, SystemConfigTargetKey } from '../types';

/**
 * AppErrors are answered directly (instead of via the global error handler)
 * so 502/503 messages like "System Configs manager is not configured" reach
 * the frontend verbatim even in production, matching the API contract.
 */
const respondAppError = (error: unknown, res: Response, next: NextFunction) => {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  next(error);
};

const parseTargetParam = (value: unknown): SystemConfigTargetKey => {
  if (value === 'rider' || value === 'driver') {
    return value;
  }
  throw new AppError("Query parameter 'target' must be 'rider' or 'driver'", 400);
};

/**
 * GET /api/system-configs/targets
 * Reports configured:false (200, not 503) when unconfigured so the frontend
 * can render a friendly "not configured" state.
 */
export const getTargets = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = SystemConfigsConfig.getInstance();
    if (!config.isConfigured()) {
      return res.json({ configured: false, targets: [] });
    }
    res.json({ configured: true, targets: config.getAvailableTargets() });
  } catch (error) {
    respondAppError(error, res, next);
  }
};

/**
 * GET /api/system-configs/keys?target=rider|driver&search=<substring>
 */
export const getKeys = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = parseTargetParam(req.query.target);
    const search = typeof req.query.search === 'string' && req.query.search.trim() !== ''
      ? req.query.search.trim().substring(0, 200)
      : undefined;

    const keys = await systemConfigsService.listKeys(target, search);
    res.json({ keys });
  } catch (error) {
    respondAppError(error, res, next);
  }
};

/**
 * GET /api/system-configs/config?target=rider|driver&id=<config id>
 */
export const getConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = parseTargetParam(req.query.target);
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    if (!id) {
      throw new AppError("Query parameter 'id' is required", 400);
    }

    const result = await systemConfigsService.getConfig(target, id);
    res.json(result);
  } catch (error) {
    respondAppError(error, res, next);
  }
};

/**
 * POST /api/system-configs/validate
 * Pure validation against the Tables type — always 200 with { valid, errors }.
 */
export const validateConfigValue = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { configValue } = req.body as { target: SystemConfigTargetKey; configValue: string };
    const result = systemConfigsService.validateConfigValue(configValue);
    res.json(result);
  } catch (error) {
    respondAppError(error, res, next);
  }
};

/**
 * POST /api/system-configs/execute
 * bcrypt password re-verification FIRST (same destructive-ops pattern as
 * query.controller), then the write, then the AWAITED audit insert.
 */
export const executeUpdate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const { target, id, configValue, password } = req.body as SystemConfigExecuteRequest;

    // Verify the manager's own password before anything touches the dashboard
    const dbPools = DatabasePools.getInstance();
    const userResult = await dbPools.history.query(
      'SELECT password_hash FROM dual_db_manager.users WHERE username = $1',
      [user.username]
    );

    if (userResult.rows.length === 0) {
      // 403, not 404 — on this route 404 means "config id not found" to the client
      throw new AppError('User account not found', 403);
    }

    const passwordValid = await bcrypt.compare(password, userResult.rows[0].password_hash);
    if (!passwordValid) {
      logger.warn('Password verification failed for system config update', {
        username: user.username,
        target,
        id,
      });
      throw new AppError('Invalid password', 401);
    }

    logger.info('System config update requested', {
      user: user.email,
      target,
      id,
    });

    const config = SystemConfigsConfig.getInstance();
    const targetConfig = config.getTarget(target);
    if (!targetConfig) {
      throw new AppError('System Configs manager is not configured', 503);
    }

    const result = await systemConfigsService.executeUpdate(target, id, configValue);

    // AWAITED, not fire-and-forget: this row is the only record of which
    // human changed prod config — it must be written (or loudly fail in logs)
    // before we report success.
    await historyService.saveSystemConfigOperation(user.id, target, {
      schema: targetConfig.schema,
      configId: id,
      oldValue: result.oldValue,
      newValue: configValue,
      durationMs: result.durationMs,
      verified: result.verified,
      dashboardStatus: result.dashboardStatus,
    });

    res.json({
      success: true,
      target,
      id,
      operation: 'UPDATE',
      durationMs: result.durationMs,
      verified: result.verified,
      oldValue: result.oldValue,
    });
  } catch (error) {
    respondAppError(error, res, next);
  }
};
