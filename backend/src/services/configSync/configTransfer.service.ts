import { spawn, ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { PoolClient } from 'pg';
import logger from '../../utils/logger';
import { ExecutionManager } from '../query/ExecutionManager';
import { QueryResponse } from '../../types';
import { resolveConfigSyncPaths, ensureEnvironmentsJsonInPlace } from '../../config/config-sync-loader';
import DatabasePools from '../../config/database';
import configSyncAssetsService from './configSyncAssets.service';
import configSyncVersionsService, { ConfigSyncVersion, VersionStatus } from './configSyncVersions.service';

export const VALID_ENVS = ['prod', 'prod_international', 'master', 'env', 'local'] as const;
export type ConfigSyncEnv = typeof VALID_ENVS[number];

export const ALLOWED_PATCH_TRANSFERS: Array<[ConfigSyncEnv, ConfigSyncEnv]> = [
  ['prod', 'local'], ['prod', 'master'],
  ['prod_international', 'local'], ['prod_international', 'master'],
  ['master', 'local'], ['env', 'local'],
];

const SAFE_IDENT_REGEX = /^[a-zA-Z0-9_]+$/;

export function assertValidEnv(env: string): asserts env is ConfigSyncEnv {
  if (!(VALID_ENVS as readonly string[]).includes(env)) {
    throw new Error(`Invalid environment '${env}'. Must be one of: ${VALID_ENVS.join(', ')}`);
  }
}

export function assertSafeIdentifiers(values: string[] | undefined, label: string): void {
  for (const v of values || []) {
    if (!SAFE_IDENT_REGEX.test(v)) {
      throw new Error(`Invalid ${label} '${v}'. Only letters, numbers, and underscores are allowed.`);
    }
  }
}

/**
 * Which env THIS deployment is allowed to touch — set per-deployment via
 * CONFIG_SYNC_ALLOWED_ENVS, exactly ONE environment name, not a list (per
 * review: a deployment represents one cluster's credentials, so it should
 * never be asked to juggle more than one real source env). 'local' is always
 * implicitly included alongside it — it's never a second credential to
 * configure, just this deployment's own database. Unset = all VALID_ENVS
 * (local dev convenience only — every real deployment should set this
 * explicitly).
 */
export function getAllowedEnvs(): ConfigSyncEnv[] {
  const raw = process.env.CONFIG_SYNC_ALLOWED_ENVS?.trim();
  if (!raw) return [...VALID_ENVS];
  assertValidEnv(raw);
  return raw === 'local' ? ['local'] : [raw, 'local'];
}

function assertEnvAllowedForDeployment(env: string): void {
  const allowed = getAllowedEnvs();
  if (!(allowed as string[]).includes(env)) {
    throw new Error(`Environment '${env}' is not available on this deployment. Allowed: ${allowed.join(', ')}`);
  }
}

/**
 * The one From/To pair this deployment actually runs — resolved entirely
 * server-side from CONFIG_SYNC_ALLOWED_ENVS, never sent by or exposed to the
 * client (per review: allowed-envs "should not be exposed to UI"). Returns
 * null if this deployment's allowed envs don't form any valid transfer.
 */
function resolveDeploymentTransferPair(): [ConfigSyncEnv, ConfigSyncEnv] | null {
  const allowed = getAllowedEnvs();
  for (const [from, to] of ALLOWED_PATCH_TRANSFERS) {
    if (allowed.includes(from) && allowed.includes(to)) return [from, to];
  }
  return null;
}

export interface ConfigSyncResult {
  kind: 'export' | 'patch' | 'export+patch';
  argv: string[];
  log: string[];
  auditWarnings: string[];
  exitCode: number | null;
}

export interface JobHandle {
  proc: ChildProcess | null;
  emitter: EventEmitter;
  /**
   * Every line emitted so far. Kept on the handle (not just in runSteps'
   * local closure) so a stream client that connects late — or reconnects
   * mid-job — can be replayed the lines it missed. Without this, a client
   * only ever sees lines emitted strictly after its connection went live,
   * which in practice means it misses the opening stage banner every time,
   * and loses everything sent during any reconnect gap.
   */
  logLines: string[];
  /**
   * How many lines have been trimmed off the front of logLines by the
   * 5000-line cap. Needed so SSE event ids stay absolute and monotonic
   * across trimming — a client's Last-Event-ID has to keep meaning the
   * same thing even after the buffer has rolled.
   */
  dropped: number;
}

const activeJobs = new Map<string, JobHandle>();

// Postgres advisory lock — stops two people (or two tabs) from running
// Config Sync at the same time. Needed because export/patch both write to
// FIXED file paths (environments.json, config.json, patches.json) and
// version numbers are read-then-written (getNextVersion()) — two concurrent
// runs can clobber each other's files or collide on the same S3 version.
// Held on ONE dedicated connection for the whole job's duration (advisory
// locks are session-scoped), released when the job finishes, errors, or
// (if the pod dies mid-job) automatically when that connection drops.
const JOB_LOCK_KEY = "hashtext('config_sync_job')";

async function acquireJobLock(): Promise<PoolClient | null> {
  const client = await DatabasePools.getInstance().history.connect();
  const result = await client.query(`SELECT pg_try_advisory_lock(${JOB_LOCK_KEY}) AS acquired`);
  if (result.rows[0]?.acquired) {
    return client;
  }
  client.release();
  return null;
}

async function releaseJobLock(client: PoolClient): Promise<void> {
  try {
    await client.query(`SELECT pg_advisory_unlock(${JOB_LOCK_KEY})`);
  } catch (error) {
    logger.warn('Config Sync: failed to release job advisory lock (connection likely already gone)', { error });
  } finally {
    client.release();
  }
}

interface JobStep {
  kind: 'export' | 'patch';
  argv: string[];
  /** Set only for a 'patch' step run with --s3, so we know to record the version after it succeeds. */
  s3?: {
    bucket: string; direction: string; version: number; description: string;
    uploadedBy: string | undefined; uploadedByUsername: string | undefined;
  };
}

class ConfigTransferService {
  private executionManager = new ExecutionManager();

  public getStatus(executionId: string) {
    return this.executionManager.getExecutionStatus(executionId);
  }

  /**
   * Live stdout/stderr subscription for a job still running on THIS pod.
   * Relies on the backend Service's sessionAffinity: ClientIP (k8s/backend.yaml)
   * to guarantee a reconnecting client keeps hitting the pod that spawned the
   * process — there is no cross-pod fan-out here by design.
   *
   * Returns the whole handle rather than just the emitter so the caller can
   * replay already-buffered lines before subscribing to new ones (see
   * JobHandle.logLines).
   */
  public subscribe(executionId: string): JobHandle | null {
    return activeJobs.get(executionId) ?? null;
  }

  /**
   * Cancel a running job. Kills the WHOLE process group, not just the
   * immediate python3 PID: config_transfer.py's `patch` step spawns
   * passetto-server as its own child (plain subprocess.Popen, no
   * start_new_session) — it inherits the process group we create via
   * `detached: true` in runStep(). Killing only the parent would leak that
   * grandchild, leaving port 8089 held. This mirrors exactly how the
   * upstream server.py's own `_stop_task` already handles this (os.killpg),
   * so it's a proven approach for this specific script, not a novel one.
   */
  public async cancel(executionId: string): Promise<boolean> {
    await this.executionManager.markAsCancelled(executionId);
    const job = activeJobs.get(executionId);
    if (!job || !job.proc || job.proc.pid === undefined) {
      return false;
    }
    const pid = job.proc.pid;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // already dead
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already reaped
      }
    }, 5000).unref();
    return true;
  }

  /**
   * Combined flow: export, then (if it succeeds) patch, as ONE job/
   * executionId. From/To env are never passed in — resolved entirely from
   * this deployment's own CONFIG_SYNC_ALLOWED_ENVS, per review feedback that
   * env selection shouldn't be a client concern at all.
   */
  public async startExportAndPatch(
    params: { schemas?: string[]; tables?: string[]; parallel?: number; s3?: boolean; versionDescription?: string },
    userId?: string,
    username?: string
  ): Promise<{ executionId: string }> {
    const pair = resolveDeploymentTransferPair();
    if (!pair) {
      throw new Error('This deployment has no valid Export & Patch transfer configured (check CONFIG_SYNC_ALLOWED_ENVS).');
    }
    const [fromEnv, toEnv] = pair;

    const exportStep = this.buildExportStep({ fromEnv, schemas: params.schemas, tables: params.tables, parallel: params.parallel });
    const patchStep = await this.buildPatchStep({
      fromEnv, toEnv, schemas: params.schemas, s3: params.s3, versionDescription: params.versionDescription,
      uploadedBy: userId, uploadedByUsername: username,
    });
    return this.runSteps([exportStep, patchStep], userId);
  }

  /** Versions for THIS deployment's one resolved direction — never exposed
   * to the client as a choice, same as the env pair itself. */
  public async listVersions(): Promise<ConfigSyncVersion[]> {
    const pair = resolveDeploymentTransferPair();
    if (!pair) return [];
    const [fromEnv, toEnv] = pair;
    return configSyncVersionsService.listVersions(`${fromEnv}_to_${toEnv}`);
  }

  public async setVersionStatus(
    version: number, status: VersionStatus, verifiedBy: string | undefined, verifiedByUsername: string | undefined
  ): Promise<ConfigSyncVersion> {
    const pair = resolveDeploymentTransferPair();
    if (!pair) {
      throw new Error('This deployment has no valid Export & Patch transfer configured (check CONFIG_SYNC_ALLOWED_ENVS).');
    }
    const [fromEnv, toEnv] = pair;
    const bucket = process.env.CONFIG_SYNC_S3_BUCKET;
    if (!bucket) {
      throw new Error('CONFIG_SYNC_S3_BUCKET is not set.');
    }
    return configSyncVersionsService.setStatus({
      bucket, direction: `${fromEnv}_to_${toEnv}`, version, status, verifiedBy, verifiedByUsername,
    });
  }

  private buildExportStep(params: { fromEnv: string; schemas?: string[]; tables?: string[]; parallel?: number }): JobStep {
    assertValidEnv(params.fromEnv);
    assertEnvAllowedForDeployment(params.fromEnv);
    assertSafeIdentifiers(params.schemas, 'schema');
    assertSafeIdentifiers(params.tables, 'table');
    const parallel = Math.min(Math.max(params.parallel ?? 4, 1), 16);

    const argv = ['export', '--from', params.fromEnv, '--parallel', String(parallel)];
    for (const s of params.schemas || []) argv.push('--schema', s);
    for (const t of params.tables || []) argv.push('--table', t);

    return { kind: 'export', argv };
  }

  private async buildPatchStep(params: {
    fromEnv: string; toEnv: string; schemas?: string[];
    s3?: boolean; versionDescription?: string;
    uploadedBy?: string; uploadedByUsername?: string;
  }): Promise<JobStep> {
    assertValidEnv(params.fromEnv);
    assertValidEnv(params.toEnv);
    assertEnvAllowedForDeployment(params.fromEnv);
    assertEnvAllowedForDeployment(params.toEnv);
    assertSafeIdentifiers(params.schemas, 'schema');
    if (!ALLOWED_PATCH_TRANSFERS.some(([f, t]) => f === params.fromEnv && t === params.toEnv)) {
      throw new Error(`Transfer ${params.fromEnv} -> ${params.toEnv} is not allowed.`);
    }

    const argv = ['patch', '--from', params.fromEnv, '--to', params.toEnv];
    for (const s of params.schemas || []) argv.push('--schema', s);

    let s3Info: JobStep['s3'];
    if (params.s3) {
      const description = (params.versionDescription || '').trim();
      if (!description) {
        throw new Error('A version description is required when publishing to S3.');
      }
      // There's only one real bucket per deployment — not a per-request choice,
      // and not baked into the code as a default. Must be set via k8s manifest.
      const bucket = process.env.CONFIG_SYNC_S3_BUCKET;
      if (!bucket) {
        throw new Error('CONFIG_SYNC_S3_BUCKET is not set — cannot publish to S3.');
      }
      const direction = `${params.fromEnv}_to_${params.toEnv}`;

      // Same versioned layout config_transfer.py's own DEFAULT_FETCH_VERSIONS
      // already reads from (e.g. master_to_local/v3) — computed here, BEFORE
      // spawning, since it determines the --s3-prefix the subprocess pushes to.
      // Source of truth is Postgres now (config_sync_versions), not S3 itself.
      const version = await configSyncVersionsService.getNextVersion(direction);
      const prefix = `${direction}/v${version}`;

      argv.push('--s3', '--s3-bucket', bucket, '--s3-prefix', prefix);
      s3Info = {
        bucket, direction, version, description,
        uploadedBy: params.uploadedBy, uploadedByUsername: params.uploadedByUsername,
      };
    }

    return { kind: 'patch', argv, s3: s3Info };
  }

  /**
   * Runs a sequence of steps (1 for export-only/patch-only, 2 for the
   * combined export+patch flow) under a single executionId. A failed or
   * cancelled step aborts the whole job — later steps are skipped.
   */
  private async runSteps(steps: JobStep[], userId?: string): Promise<{ executionId: string }> {
    const lockClient = await acquireJobLock();
    if (!lockClient) {
      throw new Error('A Config Sync job is already running on this deployment. Please wait for it to finish before starting another.');
    }

    // Everything from here until the background IIFE starts must release
    // the lock on failure too — otherwise a setup error leaks it forever
    // (the background IIFE's own finally only covers what happens after it
    // actually starts running).
    let executionId: string;
    let emitter: EventEmitter;
    const logLines: string[] = [];
    try {
      ensureEnvironmentsJsonInPlace();
      await configSyncAssetsService.writeToDisk();

      executionId = uuidv4();
      emitter = new EventEmitter();
      emitter.setMaxListeners(20);
      activeJobs.set(executionId, { proc: null, emitter, logLines, dropped: 0 });

      await this.executionManager.initializeExecution(executionId, userId);
      await this.executionManager.updateProgress(executionId, 0, steps.length);
    } catch (error) {
      await releaseJobLock(lockClient);
      throw error;
    }

    const kind: ConfigSyncResult['kind'] = steps.length > 1 ? 'export+patch' : steps[0].kind;
    const allArgv: string[] = [];
    const auditWarnings: string[] = [];

    // The single append path for every log line — stage banners and raw
    // subprocess output alike — so the buffer, the trim bookkeeping and the
    // live emit can never drift apart. The sequence number emitted alongside
    // each line is what becomes its SSE event id, letting a reconnecting
    // client resume from exactly where it dropped off.
    const appendLine = (line: string) => {
      const handle = activeJobs.get(executionId);
      logLines.push(line);
      if (logLines.length > 5000) {
        logLines.shift();
        if (handle) handle.dropped += 1;
      }
      const seq = (handle?.dropped ?? 0) + logLines.length - 1;
      handle?.emitter.emit('line', line, seq);
    };

    const STAGE_TITLES: Record<string, string> = { export: 'EXPORT', patch: 'PATCH' };
    const emitStageLine = appendLine;
    const emitStageStart = (title: string) => {
      emitStageLine('');
      emitStageLine('━'.repeat(60));
      emitStageLine(`▶ STAGE: ${title}`);
      emitStageLine('━'.repeat(60));
    };
    const emitStageEnd = (title: string, ok: boolean, startedAt: number) => {
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      emitStageLine(`${ok ? '✔' : '✘'} STAGE: ${title} — ${ok ? 'done' : 'failed'} (${secs}s)`);
    };

    // Fire-and-continue: caller gets executionId immediately, the chain
    // below runs in the background and reports through ExecutionManager.
    // Wrapped in try/finally so the job lock is released no matter how this
    // ends — normal completion, cancellation, or an unexpected throw.
    void (async () => {
      try {
        let exitCode: number | null = 0;
        let cancelled = false;

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          allArgv.push(...step.argv);
          cancelled = await this.executionManager.isCancelled(executionId);
          if (cancelled) break;

          const label = steps.length > 1 ? `[${step.kind}] ` : '';
          const stageTitle = STAGE_TITLES[step.kind] || step.kind.toUpperCase();
          const stageStart = Date.now();
          emitStageStart(stageTitle);
          exitCode = await this.runStep(executionId, step, label, appendLine, auditWarnings);
          emitStageEnd(stageTitle, exitCode === 0, stageStart);
          await this.executionManager.updateProgress(executionId, i + 1, steps.length);

          if (exitCode !== 0) break;

          if (step.kind === 'patch' && step.s3) {
            const s3Start = Date.now();
            emitStageStart('PUSH TO S3');
            const { bucket, direction, version, description, uploadedBy, uploadedByUsername } = step.s3;
            try {
              await configSyncVersionsService.recordUpload({
                bucket, direction, version, description, uploadedBy, uploadedByUsername,
              });
              emitStageLine(`[metadata] Recorded v${version} (uploaded by ${uploadedByUsername || 'unknown'}) and synced to s3://${bucket}/${direction}/metadata.json`);
              emitStageEnd('PUSH TO S3', true, s3Start);
            } catch (err: any) {
              logger.warn('Config Sync: failed to record version / sync S3 metadata.json (zip push already succeeded)', {
                executionId, error: err?.message,
              });
              // Recording the version is best-effort — the zip itself already
              // pushed successfully in the PATCH stage above, so this stage is
              // marked done (not failed) even though the version record didn't update.
              emitStageLine(`[metadata] WARNING: failed to record version: ${err?.message}`);
              emitStageEnd('PUSH TO S3', true, s3Start);
            }
          }
        }

        cancelled = cancelled || await this.executionManager.isCancelled(executionId);
        const success = exitCode === 0 && !cancelled;
        const result: ConfigSyncResult = { kind, argv: allArgv, log: logLines, auditWarnings, exitCode };
        const response: QueryResponse = { id: executionId, success, configSync: result };
        await this.executionManager.completeExecution(executionId, response, success);
        this.executionManager.completeActiveExecution(executionId);

        const job = activeJobs.get(executionId);
        job?.emitter.emit('done', exitCode);
        activeJobs.delete(executionId);
        logger.info('Config Sync job finished', { executionId, kind, exitCode, cancelled });
      } finally {
        await releaseJobLock(lockClient);
      }
    })();

    return { executionId };
  }

  private runStep(
    executionId: string,
    step: JobStep,
    logPrefix: string,
    appendLine: (line: string) => void,
    auditWarnings: string[]
  ): Promise<number | null> {
    const { scriptPath, scriptDir } = resolveConfigSyncPaths();
    const job = activeJobs.get(executionId);

    return new Promise((resolve) => {
      const proc = spawn('python3', [scriptPath, ...step.argv], {
        cwd: scriptDir,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (job) job.proc = proc;

      let capturingAudit = false;
      const onLine = (rawLine: string): void => {
        appendLine(logPrefix + rawLine);

        if (rawLine.includes('PATCH AUDIT WARNINGS')) {
          capturingAudit = true;
          return;
        }
        if (capturingAudit) {
          if (rawLine.trim() === '') {
            capturingAudit = false;
          } else {
            auditWarnings.push(rawLine.trim());
          }
        }
      };
      attachLineReader(proc.stdout!, onLine);
      attachLineReader(proc.stderr!, onLine);

      proc.on('close', (code) => {
        if (job) job.proc = null;
        resolve(code);
      });

      proc.on('error', (err) => {
        logger.error('Config Sync subprocess failed to start', { executionId, step: step.kind, error: err.message });
        appendLine(`${logPrefix}ERROR: failed to start: ${err.message}`);
        resolve(1);
      });
    });
  }
}

function attachLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  stream.on('end', () => {
    if (buf) onLine(buf);
  });
}

export default new ConfigTransferService();
