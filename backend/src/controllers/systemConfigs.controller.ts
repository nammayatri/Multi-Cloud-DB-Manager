import { Request, Response, NextFunction } from 'express';
import systemConfigsService from '../services/systemConfigs/SystemConfigsService';
import logger from '../utils/logger';
import { AppError } from '../middleware/error.middleware';
import { loadLeanFlowFeaturesConfig } from '../config/leanFlowFeaturesLoader';

export const getLeanFlowFeatures = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(loadLeanFlowFeaturesConfig());
  } catch (error) {
    next(error);
  }
};

export const listConfigs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { database, cloud, pgSchema } = req.query as Record<string, string | undefined>;
    if (!database || !cloud || !pgSchema) {
      throw new AppError('database, cloud and pgSchema query parameters are required', 400);
    }

    const configs = await systemConfigsService.listConfigs(cloud, database, pgSchema);
    res.json({ configs });
  } catch (error) {
    next(error);
  }
};

export const updateConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const { database, cloud, pgSchema, id, configValue } = req.body;

    logger.info('System config update', {
      user: user.email,
      role: user.role,
      database,
      cloud,
      pgSchema,
      id,
    });

    const updated = await systemConfigsService.updateConfig(cloud, database, pgSchema, id, configValue);
    res.json({ config: updated });
  } catch (error) {
    next(error);
  }
};
