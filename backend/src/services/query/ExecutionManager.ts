import logger from '../../utils/logger';
import { QueryResponse } from '../../types';
import redisClient from '../../config/redis';

/**
 * Execution result storage for async queries
 */
export interface ExecutionResult {
  executionId: string;
  userId?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  result?: QueryResponse;
  error?: string;
  progress?: {
    currentStatement: number;
    totalStatements: number;
    currentStatementText?: string;
  };
  startTime: number;
  endTime?: number;
}

// In-memory storage for active executions (cancellation, client tracking)
// These are pod-specific and don't need to be shared
interface ActiveExecution {
  executionId: string;
  clients: Map<string, { client: any; backendPid?: number }>;
  startTime: number;
  cancelled: boolean;
}

/**
 * ExecutionManager - Manages query execution state using Redis
 * Local dev (localhost Redis) uses in-memory fallback for execution results
 * Production always uses Redis — no in-memory fallback
 * Active execution tracking (cancellation, clients) is always in-memory (pod-specific)
 */
export class ExecutionManager {
  private activeExecutions: Map<string, ActiveExecution> = new Map();
  private readonly REDIS_KEY_PREFIX = 'execution:';
  private readonly REDIS_TTL_SECONDS: number;
  private readonly isLocalRedis: boolean;

  // In-memory fallback only for local development
  private inMemoryFallback: Map<string, ExecutionResult> | null = null;

  constructor() {
    this.REDIS_TTL_SECONDS = parseInt(process.env.REDIS_EXECUTION_TTL_SECONDS || '300', 10);

    const redisHost = process.env.REDIS_HOST || 'localhost';
    this.isLocalRedis = redisHost === 'localhost' || redisHost === '127.0.0.1';

    // Only create in-memory fallback for local dev
    if (this.isLocalRedis) {
      this.inMemoryFallback = new Map();
      setInterval(() => this.cleanupFallback(), 5 * 60 * 1000);
    }
  }

  private cleanupFallback(): void {
    if (!this.inMemoryFallback) return;
    const now = Date.now();
    const maxAge = 25 * 60 * 1000;
    for (const [id, result] of this.inMemoryFallback.entries()) {
      if (result.endTime && (now - result.endTime > maxAge)) {
        this.inMemoryFallback.delete(id);
      }
    }
  }

  private getRedisKey(executionId: string): string {
    return `${this.REDIS_KEY_PREFIX}${executionId}`;
  }

  /**
   * Store execution result — Redis in production, in-memory fallback for local dev only
   */
  private async setResult(executionId: string, result: ExecutionResult): Promise<void> {
    try {
      await redisClient.setEx(
        this.getRedisKey(executionId),
        this.REDIS_TTL_SECONDS,
        JSON.stringify(result)
      );
    } catch (error) {
      if (this.isLocalRedis && this.inMemoryFallback) {
        this.inMemoryFallback.set(executionId, result);
        return;
      }
      throw error; // In production, let it fail — don't silently swallow
    }
  }

  /**
   * Get execution result — Redis in production, in-memory fallback for local dev only
   */
  private async getResult(executionId: string): Promise<ExecutionResult | null> {
    try {
      const data = await redisClient.get(this.getRedisKey(executionId));
      if (data) {
        return JSON.parse(data) as ExecutionResult;
      }
    } catch (error) {
      if (this.isLocalRedis && this.inMemoryFallback) {
        return this.inMemoryFallback.get(executionId) || null;
      }
      throw error;
    }

    // Not in Redis, check local fallback
    if (this.isLocalRedis && this.inMemoryFallback) {
      return this.inMemoryFallback.get(executionId) || null;
    }
    return null;
  }

  /**
   * Initialize a new execution
   */
  public async initializeExecution(executionId: string, userId?: string): Promise<void> {
    const execution: ExecutionResult = {
      executionId,
      userId,
      status: 'running',
      startTime: Date.now(),
      progress: {
        currentStatement: 0,
        totalStatements: 0
      }
    };
    await this.setResult(executionId, execution);
  }

  /**
   * Get execution status
   */
  public async getExecutionStatus(executionId: string): Promise<ExecutionResult | null> {
    return this.getResult(executionId);
  }

  /**
   * Get active execution (in-memory, pod-specific)
   */
  public getActiveExecution(executionId: string): ActiveExecution | undefined {
    return this.activeExecutions.get(executionId);
  }

  /**
   * Register an active execution with its clients (in-memory, pod-specific)
   */
  public registerActiveExecution(
    executionId: string,
    cloudKey: string,
    client: any,
    backendPid?: number
  ): void {
    let execution = this.activeExecutions.get(executionId);
    if (!execution) {
      execution = {
        executionId,
        clients: new Map(),
        startTime: Date.now(),
        cancelled: false
      };
      this.activeExecutions.set(executionId, execution);
    }
    execution.clients.set(cloudKey, { client, backendPid });
  }

  /**
   * Mark execution as cancelled
   */
  public async markAsCancelled(executionId: string): Promise<boolean> {
    // Set in-memory flag (pod-specific cancellation tracking)
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.cancelled = true;
    }

    // Update Redis status (for cross-pod visibility)
    try {
      const result = await this.getResult(executionId);
      if (!result) {
        return !!execution;
      }
      result.status = 'cancelled';
      result.endTime = Date.now();
      await this.setResult(executionId, result);
      return true;
    } catch (error) {
      logger.error('Failed to mark execution as cancelled', { executionId, error });
      return !!execution;
    }
  }

  /**
   * Get all active executions (in-memory, pod-specific)
   */
  public getActiveExecutions(): Array<{ executionId: string; startTime: number; duration_ms: number }> {
    const now = Date.now();
    return Array.from(this.activeExecutions.values()).map(exec => ({
      executionId: exec.executionId,
      startTime: exec.startTime,
      duration_ms: now - exec.startTime
    }));
  }

  /**
   * Get all backend PIDs for an execution (in-memory, pod-specific)
   */
  public getBackendPids(executionId: string): Array<{ cloudKey: string; pid: number }> {
    const execution = this.activeExecutions.get(executionId);
    if (!execution) {
      return [];
    }

    const pids: Array<{ cloudKey: string; pid: number }> = [];
    for (const [cloudKey, clientInfo] of execution.clients.entries()) {
      if (clientInfo.backendPid) {
        pids.push({ cloudKey, pid: clientInfo.backendPid });
      }
    }
    return pids;
  }

  /**
   * Update execution progress
   */
  public async updateProgress(
    executionId: string,
    currentStatement: number,
    totalStatements: number,
    currentStatementText?: string
  ): Promise<void> {
    try {
      const result = await this.getResult(executionId);
      if (result) {
        result.progress = { currentStatement, totalStatements, currentStatementText };
        await this.setResult(executionId, result);
      }
    } catch (error) {
      logger.warn('Failed to update progress', { executionId, error });
    }
  }

  /**
   * Save partial results without changing status (used during multi-cloud execution)
   */
  public async savePartialResults(
    executionId: string,
    response: QueryResponse
  ): Promise<void> {
    try {
      const result = await this.getResult(executionId);
      if (result) {
        result.result = response;
        await this.setResult(executionId, result);
      }
    } catch (error) {
      logger.warn('Failed to save partial results', { executionId, error });
    }
  }

  /**
   * Complete execution with result
   */
  public async completeExecution(
    executionId: string,
    response: QueryResponse,
    success: boolean
  ): Promise<void> {
    try {
      const result = await this.getResult(executionId);
      if (result) {
        result.result = response;
        if (result.status !== 'cancelled') {
          result.status = success ? 'completed' : 'failed';
        }
        result.endTime = Date.now();
        await this.setResult(executionId, result);
      }
    } catch (error) {
      logger.warn('Failed to complete execution', { executionId, error });
    }
  }

  /**
   * Complete execution with error
   */
  public async failExecution(executionId: string, errorMessage: string): Promise<void> {
    try {
      const result = await this.getResult(executionId);
      if (result) {
        if (result.status !== 'cancelled') {
          result.status = 'failed';
          result.error = errorMessage;
          result.endTime = Date.now();
        }
        await this.setResult(executionId, result);
      }
    } catch (error) {
      logger.warn('Failed to mark execution as failed', { executionId, error });
    }
  }

  /**
   * Release a client for an execution (in-memory, pod-specific)
   */
  public releaseClient(executionId: string, cloudKey: string): void {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.clients.delete(cloudKey);
    }
  }

  /**
   * Remove active execution entry (called after full execution completes)
   */
  public completeActiveExecution(executionId: string): void {
    this.activeExecutions.delete(executionId);
  }

  /**
   * Check if execution was cancelled.
   * Checks in-memory first (fast), then Redis for cross-pod visibility.
   */
  public async isCancelled(executionId: string): Promise<boolean> {
    // Always check in-memory first (fast path, covers same-pod cancellation)
    const execution = this.activeExecutions.get(executionId);
    if (execution?.cancelled) {
      return true;
    }

    // For local Redis, in-memory is sufficient (single pod)
    if (this.isLocalRedis) {
      return false;
    }

    // For remote Redis, check Redis for cross-pod cancellation
    try {
      const result = await this.getResult(executionId);
      if (result?.status === 'cancelled') {
        if (execution) {
          execution.cancelled = true;
        }
        return true;
      }
    } catch {
      // Redis failed, rely on in-memory
    }

    return false;
  }
}

export default ExecutionManager;
