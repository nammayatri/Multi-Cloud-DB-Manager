import { Request, Response, NextFunction } from 'express';
import configTransferService from '../services/configSync/configTransfer.service';
import configSyncAssetsService, { ConfigSyncAssetName } from '../services/configSync/configSyncAssets.service';
import { AppError } from '../middleware/error.middleware';
import logger from '../utils/logger';

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
  const job = configTransferService.subscribe(executionId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  if (!job) {
    res.write('event: unavailable\ndata: {}\n\n');
    res.end();
    return;
  }

  const { emitter } = job;

  // Reconnect fast. The proxy chain in front of this endpoint caps a single
  // response's lifetime (Pomerium's per-route timeout defaults to 30s and
  // this route doesn't override it), so a long job WILL be cut off partway
  // no matter what this handler does. That's survivable rather than fatal
  // because of the id/Last-Event-ID resume below — the cut turns into a ~1s
  // gap instead of losing the rest of the log.
  res.write('retry: 1000\n\n');

  const writeLine = (line: string, seq: number) => {
    res.write(`id: ${seq}\ndata: ${JSON.stringify(line)}\n\n`);
  };

  // Catch-up replay. Two cases both land here: a first connection (the POST
  // that started the job has already emitted the opening stage banner before
  // the browser's EventSource finished connecting) and a reconnect after the
  // proxy cut the previous response. EventSource echoes the last id it saw
  // back as Last-Event-ID, so we resend only what this client actually
  // missed. Safe to do synchronously before subscribing: emits only ever
  // originate from I/O callbacks, so nothing can slip in between.
  const lastSeen = Number(req.headers['last-event-id'] ?? -1);
  const resumeFrom = Number.isFinite(lastSeen) ? lastSeen : -1;
  job.logLines.forEach((line, i) => {
    const seq = job.dropped + i;
    if (seq > resumeFrom) writeLine(line, seq);
  });

  const onLine = (line: string, seq: number) => writeLine(line, seq);
  const onDone = (exitCode: number | null) => {
    res.write(`event: done\ndata: ${JSON.stringify({ exitCode })}\n\n`);
    cleanup();
    res.end();
  };
  // The ingress in front of every deployment is GCE-class (GCP's HTTP(S) LB,
  // confirmed via `kubectl get ingress`), whose backend service kills a
  // connection after 30s with zero bytes sent, independent of Content-Type.
  // A comment line (leading ':') is invisible to EventSource's onmessage but
  // still counts as traffic — sending one periodically keeps the connection
  // looking active for as long as the job is genuinely still running,
  // even through stretches where config_transfer.py itself prints nothing.
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);
  const cleanup = () => {
    emitter.off('line', onLine);
    emitter.off('done', onDone);
    clearInterval(keepAlive);
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
