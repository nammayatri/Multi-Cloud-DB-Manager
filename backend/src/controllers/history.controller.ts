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

    // MASTER sees all users' history by default, can filter by specific user
    // Non-MASTER users always see only their own history
    let userId: string | undefined;
    if ((user as any).role === 'MASTER') {
      // MASTER can optionally filter by a specific user_id
      userId = req.query.user_id as string | undefined;
    } else {
      userId = user.id;
    }

    const filter: QueryHistoryFilter = {
      user_id: userId,
      schema: (req.query.database || req.query.schema) as string | undefined,
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
