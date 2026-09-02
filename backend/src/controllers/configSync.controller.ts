import { Request, Response, NextFunction } from 'express';
import configTransferService from '../services/configSync/configTransfer.service';
import configSyncAssetsService, { ConfigSyncAssetName } from '../services/configSync/configSyncAssets.service';
import { AppError } from '../middleware/error.middleware';

// The single combined flow — one button, export then patch as one job.
// From/To env are never taken from the request — resolved entirely
// server-side from this deployment's CONFIG_SYNC_ALLOWED_ENVS.
export const startExportAndPatch = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const { schemas, tables, parallel, s3, versionDescription } = req.body;
    const result = await configTransferService.startExportAndPatch(
      { schemas, tables, parallel, s3, versionDescription },
      user.id
    );
    res.status(202).json({ ...result, status: 'running' });
  } catch (error) {
    next(error);
  }
};

export const getStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { executionId } = req.params;
    const status = await configTransferService.getStatus(executionId);
    if (!status) {
      throw new AppError('Execution not found', 404);
    }
    res.json(status);
  } catch (error) {
    next(error);
  }
};

export const cancel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { executionId } = req.params;
    const cancelled = await configTransferService.cancel(executionId);
    res.json({
      success: cancelled,
      message: cancelled ? 'Cancellation requested' : 'Execution not found or already completed',
    });
  } catch (error) {
    next(error);
  }
};

// Live console output for a job still running on this pod. Additive to
// /status polling, not a replacement — see configTransfer.service.ts's
// subscribe() docs on the sessionAffinity assumption this relies on.
export const streamLog = async (req: Request, res: Response) => {
  const { executionId } = req.params;
  const emitter = configTransferService.subscribe(executionId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (!emitter) {
    res.write('event: unavailable\ndata: {}\n\n');
    res.end();
    return;
  }

  const onLine = (line: string) => {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  };
  const onDone = (exitCode: number | null) => {
    res.write(`event: done\ndata: ${JSON.stringify({ exitCode })}\n\n`);
    cleanup();
    res.end();
  };
  const cleanup = () => {
    emitter.off('line', onLine);
    emitter.off('done', onDone);
  };

  emitter.on('line', onLine);
  emitter.on('done', onDone);
  req.on('close', cleanup);
};

export const getAssets = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const assets = await configSyncAssetsService.getAll();
    res.json({ assets });
  } catch (error) {
    next(error);
  }
};

const VALID_ASSET_NAMES: ConfigSyncAssetName[] = ['config.json', 'patches.json'];

export const updateAsset = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = req.params.name as ConfigSyncAssetName;
    if (!VALID_ASSET_NAMES.includes(name)) {
      throw new AppError(`Unknown Config Sync asset '${name}'`, 400);
    }
    const user = req.user as Express.User;
    const updated = await configSyncAssetsService.update(name, req.body.content, user.id, user.username);
    res.json({ asset: updated });
  } catch (error) {
    next(error);
  }
};

export const getAssetHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = req.params.name as ConfigSyncAssetName;
    if (!VALID_ASSET_NAMES.includes(name)) {
      throw new AppError(`Unknown Config Sync asset '${name}'`, 400);
    }
    const history = await configSyncAssetsService.getHistory(name);
    res.json({ history });
  } catch (error) {
    next(error);
  }
};

export const getAssetHistoryEntry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entry = await configSyncAssetsService.getHistoryEntry(req.params.historyId);
    if (!entry) {
      throw new AppError('History entry not found', 404);
    }
    res.json({ entry });
  } catch (error) {
    next(error);
  }
};

export const restoreAssetVersion = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const restored = await configSyncAssetsService.restore(req.params.historyId, user.id, user.username);
    res.json({ asset: restored });
  } catch (error) {
    next(error);
  }
};
