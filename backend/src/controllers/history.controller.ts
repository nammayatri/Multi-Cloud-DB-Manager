import { Request, Response, NextFunction } from 'express';
import historyService from '../services/history.service';
import { QueryHistoryFilter } from '../types';

/**
 * Get query history
 */
export const getHistory = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user as Express.User;

    const filter: QueryHistoryFilter = {
      user_id: user.id,
      schema: req.query.schema as 'primary' | 'secondary' | undefined,
      success: req.query.success === 'true' ? true : req.query.success === 'false' ? false : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
      offset: req.query.offset ? parseInt(req.query.offset as string) : 0,
      start_date: req.query.start_date ? new Date(req.query.start_date as string) : undefined,
      end_date: req.query.end_date ? new Date(req.query.end_date as string) : undefined,
    };

    const history = await historyService.getHistory(filter);

    res.json({
      data: history,
      count: history.length,
      filter,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get single execution by ID
 */
export const getExecutionById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { id } = req.params;

    const execution = await historyService.getExecutionById(id);

    if (!execution) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Query execution not found',
      });
    }

    res.json(execution);
  } catch (error) {
    next(error);
  }
};
