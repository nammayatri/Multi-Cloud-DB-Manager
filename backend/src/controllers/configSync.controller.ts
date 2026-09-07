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
      user.id,
      user.username
    );
    res.status(202).json({ ...result, status: 'running' });
  } catch (error) {
    next(error);
  }
};

export const getVersions = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const versions = await configTransferService.listVersions();
    res.json({ versions });
  } catch (error) {
    next(error);
  }
};

export const setVersionStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as Express.User;
    const version = Number(req.params.version);
    const { status } = req.body;
    const updated = await configTransferService.setVersionStatus(version, status, user.id, user.username);
    res.json({ version: updated });
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
    // Live console output rides along with the status the frontend already
    // polls every second — see configTransfer.service.ts's getLogTail() for
    // why this isn't a streaming connection. `logFrom` is the absolute index
    // the caller has already received, so each poll returns only what's new.
    const logFrom = Number(req.query.logFrom ?? 0);
    const tail = configTransferService.getLogTail(executionId, Number.isFinite(logFrom) ? logFrom : 0);
    res.json({ ...status, liveLog: tail });
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
