import { Request, Response, NextFunction } from 'express';
import shudhiService from '../services/shudhi/ShudhiService';
import logger from '../utils/logger';
import { AppError } from '../middleware/error.middleware';

const ensureConfigured = () => {
  if (!shudhiService.isConfigured()) {
    throw new AppError('Shudhi is not configured', 503);
  }
};

export const getShudhiStatus = async (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!shudhiService.isConfigured()) {
      return res.json({ status: 'not_configured', shudhi: 'disabled' });
    }
    const health = await shudhiService.health();
    res.json({
      status: 'ok',
      shudhi: 'connected',
      redis: health.redis,
      app: health.app,
    });
  } catch (error: any) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.json({ status: 'error', shudhi: 'unreachable', message: error.message });
    }
    next(error);
  }
};

export const getServices = async (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureConfigured();
    const services = await shudhiService.getServices();
    // services is already a string[] extracted by the service layer
    res.json({ services });
  } catch (error) {
    next(error);
  }
};

export const getPods = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureConfigured();
    const { service } = req.query;
    if (!service || typeof service !== 'string') {
      throw new AppError('service query parameter is required', 400);
    }
    const pods = await shudhiService.getPods(service);
    res.json({ pods });
  } catch (error) {
    next(error);
  }
};

export const getKeys = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureConfigured();
    const { service, pod, pattern } = req.query;
    if (!service || typeof service !== 'string') {
      throw new AppError('service query parameter is required', 400);
    }
    const keys = await shudhiService.getKeys(
      service,
      pod as string | undefined,
      pattern as string | undefined
    );
    res.json({ keys });
  } catch (error) {
    next(error);
  }
};

export const getValue = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureConfigured();
    const user = req.user as Express.User;
    const { serviceName, podName, key } = req.body;

    logger.info('Shudhi get value', { user: user.email, serviceName, podName, key });

    const result = await shudhiService.getValue({ serviceName, podName, key });
    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const refreshCache = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    ensureConfigured();
    const user = req.user as Express.User;
    const { serviceName, keyInfix } = req.body;

    logger.info('Shudhi cache refresh', { user: user.email, serviceName, keyInfix });

    const result = await shudhiService.refresh({
      serviceName,
      keyInfix: keyInfix || undefined,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
};
