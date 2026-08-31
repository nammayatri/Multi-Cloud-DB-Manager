import { useCallback, useRef, useEffect } from 'react';
import { queryAPI } from '../services/api';
import type { QueryResponse, CloudResult } from '../types';

const POLL_INTERVAL = 1000;

export interface RunSqlOptions {
  database: string;
  mode: string;
  pgSchema?: string;
  continueOnError?: boolean;
  /** Required by the backend for destructive statements (ALTER DROP, DROP, ...). */
  password?: string;
}

export interface StatementError {
  statement: string;
  error: string;
}

export interface RunSqlOutcome {
  success: boolean;
  /** Every statement that failed, not just the first — a continue-on-error run can fail several. */
  statementErrors?: StatementError[];
  /** The backend demanded password verification and none (or a bad one) was given. */
  needsPassword?: boolean;
  /** Populated when the run was refused by the role policy. */
  roleDenied?: { message: string; canRequestApproval: boolean };
  error?: string;
  result?: QueryResponse;
  durationMs?: number;
  rowsAffected?: number;
}

/**
 * Collapse a per-cloud QueryResponse into a single pass/fail plus the first
 * error worth showing. A run targeting `both` clouds fails if either cloud
 * fails, so the caller can render one status per file.
 */
function summarize(result: QueryResponse): {
  success: boolean;
  error?: string;
  statementErrors: StatementError[];
  durationMs: number;
  rowsAffected: number;
} {
  let durationMs = 0;
  let rowsAffected = 0;
  let error: string | undefined;
  let success = true;
  const statementErrors: StatementError[] = [];

  for (const [key, value] of Object.entries(result)) {
    if (key === 'id' || key === 'success' || !value || typeof value !== 'object') continue;
    const cloud = value as CloudResult;
    if (typeof cloud.duration_ms !== 'number' && !('success' in cloud)) continue;

    durationMs = Math.max(durationMs, cloud.duration_ms || 0);

    if (cloud.success === false) {
      success = false;
      if (!error) error = cloud.error || `Failed on ${key}`;
      // A whole-batch failure carries no per-statement breakdown.
      if (!cloud.results?.length && cloud.error) {
        statementErrors.push({ statement: '', error: cloud.error });
      }
    }

    for (const stmt of cloud.results || []) {
      if (stmt.success === false) {
        success = false;
        const stmtError = stmt.error || `Failed on ${key}`;
        if (!error) error = stmtError;
        // With continueOnError the backend runs past a failure, so several
        // statements in one file can fail — keep every one of them.
        statementErrors.push({ statement: stmt.statement || '', error: stmtError });
      }
      rowsAffected += stmt.rowsAffected || 0;
    }

    if (cloud.result?.rowCount && !cloud.results) {
      rowsAffected += cloud.result.rowCount;
    }
  }

  return { success, error, statementErrors, durationMs, rowsAffected };
}

/**
 * Run a SQL batch through the standard execute path — validate, submit, poll to
 * completion — and resolve to a single outcome.
 *
 * This deliberately goes through /api/query/execute rather than a dedicated
 * endpoint so every caller inherits the role permissions, approval flow, audit
 * history and continueOnError semantics that already guard query execution.
 *
 * NOTE: DatabaseSelector still has its own inline copy of this flow. It can
 * adopt this hook later; that refactor is intentionally out of scope here.
 */
export function useSqlExecution() {
  const cancelledRef = useRef(false);

  // Abandon in-flight polling if the component goes away mid-run. Reset on
  // mount as well as clearing on unmount, so a remount (or StrictMode's
  // mount/unmount/mount in development) does not leave the flag latched on and
  // silently abort every subsequent run.
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);

  const runSql = useCallback(async (sql: string, options: RunSqlOptions): Promise<RunSqlOutcome> => {
    try {
      const validation = await queryAPI.validate(sql);
      if (!validation.valid) {
        return { success: false, error: validation.error || 'Invalid SQL' };
      }

      const { executionId } = await queryAPI.execute({
        query: sql,
        database: options.database,
        mode: options.mode,
        pgSchema: options.pgSchema,
        continueOnError: options.continueOnError,
        password: options.password,
      });

      return await new Promise<RunSqlOutcome>((resolve) => {
        const poll = async () => {
          if (cancelledRef.current) {
            resolve({ success: false, error: 'Cancelled' });
            return;
          }
          try {
            const status = await queryAPI.getStatus(executionId);

            if (status.status === 'running') {
              setTimeout(poll, POLL_INTERVAL);
              return;
            }

            if (!status.result) {
              resolve({
                success: false,
                error: status.error || `Execution ${status.status}`,
              });
              return;
            }

            const summary = summarize(status.result);
            resolve({
              success: status.status === 'completed' && summary.success,
              error: summary.error || status.error,
              statementErrors: summary.statementErrors,
              result: status.result,
              durationMs: summary.durationMs,
              rowsAffected: summary.rowsAffected,
            });
          } catch (err: any) {
            resolve({
              success: false,
              error: err.response?.data?.error || err.message || 'Failed to read execution status',
            });
          }
        };
        setTimeout(poll, POLL_INTERVAL);
      });
    } catch (error: any) {
      const data = error.response?.data;

      // The role policy refused it. Not a dead end — the caller can offer to
      // send it for approval, matching the DB Manager behaviour.
      if (data?.code === 'ROLE_NOT_PERMITTED') {
        return {
          success: false,
          error: data.message || 'You do not have permission to run this query',
          roleDenied: {
            message: data.message || '',
            canRequestApproval: !!data.canRequestApproval,
          },
        };
      }

      const message = data?.error || error.message || 'Execution failed';
      const needsPassword =
        /Password verification required/i.test(message) || /Invalid password/i.test(message);

      return { success: false, error: message, needsPassword };
    }
  }, []);

  return { runSql };
}
