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
 * ExecutionManager - Manages query execution state using Redis for cross-pod visibility
 * Stores execution results in Redis so all pods can access them
 * Keeps active execution tracking in-memory (pod-specific)
 */
export class ExecutionManager {
  private activeExecutions: Map<string, ActiveExecution> = new Map();
  private readonly REDIS_KEY_PREFIX = 'execution:';
  private readonly REDIS_TTL_SECONDS: number;
  private redisAvailable: boolean = true;

  private inMemoryFallback: Map<string, ExecutionResult> = new Map();

  constructor() {
    // Read TTL from env or default to 5 minutes (300 seconds)
    this.REDIS_TTL_SECONDS = parseInt(process.env.REDIS_EXECUTION_TTL_SECONDS || '300', 10);
    
    // No cleanup needed - Redis handles TTL automatically
    // In-memory fallback has its own cleanup
    setInterval(() => this.cleanupFallback(), 5 * 60 * 1000); // Cleanup every 5 minutes
  }

  /**
   * Cleanup old in-memory fallback entries
   */
  private cleanupFallback(): void {
    const now = Date.now();
    const maxAge = 25 * 60 * 1000; // 25 minutes
    
    for (const [id, result] of this.inMemoryFallback.entries()) {
      if (result.endTime && (now - result.endTime > maxAge)) {
        this.inMemoryFallback.delete(id);
      }
    }
  }

  /**
   * Check if Redis is available
   */
  private async isRedisAvailable(): Promise<boolean> {
    if (!this.redisAvailable) return false;
    
    try {
      await redisClient.ping();
      return true;
    } catch {
      this.redisAvailable = false;
      logger.warn('Redis unavailable, falling back to in-memory storage');
      
      // Try to reconnect after 30 seconds
      setTimeout(() => {
        this.redisAvailable = true;
        logger.info('Attempting to reconnect to Redis');
      }, 30000);
      
      return false;
    }
  }

  /**
   * Get Redis key for an execution
   */
  private getRedisKey(executionId: string): string {
    return `${this.REDIS_KEY_PREFIX}${executionId}`;
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

    // Check if Redis is available
    if (await this.isRedisAvailable()) {
      try {
        await redisClient.setEx(
          this.getRedisKey(executionId),
          this.REDIS_TTL_SECONDS,
          JSON.stringify(execution)
        );
        return;
      } catch (error) {
        logger.warn('Redis failed, falling back to in-memory', { executionId, error });
        this.redisAvailable = false;
      }
    }

    // Fallback to in-memory storage
    this.inMemoryFallback.set(executionId, execution);
    logger.info('Execution stored in memory (Redis unavailable)', { executionId });
  }

  /**
   * Get execution status from Redis or in-memory fallback
   */
  public async getExecutionStatus(executionId: string): Promise<ExecutionResult | null> {
    // Try Redis first
    if (await this.isRedisAvailable()) {
      try {
        const data = await redisClient.get(this.getRedisKey(executionId));
        if (data) {
          return JSON.parse(data) as ExecutionResult;
        }
      } catch (error) {
        logger.warn('Redis get failed, checking in-memory', { executionId, error });
      }
    }

    // Fallback to in-memory
    const inMemoryResult = this.inMemoryFallback.get(executionId);
    if (inMemoryResult) {
      return inMemoryResult;
    }

    return null;
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
    // Check in-memory first (pod-specific cancellation tracking)
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.cancelled = true;
    }

    // Update Redis status
    try {
      const data = await redisClient.get(this.getRedisKey(executionId));
      if (!data) {
        return false;
      }
      
      const result: ExecutionResult = JSON.parse(data);
      result.status = 'cancelled';
      result.endTime = Date.now();
      
      await redisClient.setEx(
        this.getRedisKey(executionId),
        this.REDIS_TTL_SECONDS,
        JSON.stringify(result)
      );
      
      return true;
    } catch (error) {
      logger.error('Failed to mark execution as cancelled in Redis', { executionId, error });
      return false;
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
   * Update execution progress in Redis or in-memory
   */
  public async updateProgress(
    executionId: string,
    currentStatement: number,
    totalStatements: number,
    currentStatementText?: string
  ): Promise<void> {
    const progress = { currentStatement, totalStatements, currentStatementText };

    // Try Redis first
    if (await this.isRedisAvailable()) {
      try {
        const data = await redisClient.get(this.getRedisKey(executionId));
        if (data) {
          const result: ExecutionResult = JSON.parse(data);
          result.progress = progress;
          await redisClient.setEx(
            this.getRedisKey(executionId),
            this.REDIS_TTL_SECONDS,
            JSON.stringify(result)
          );
          return;
        }
      } catch (error) {
        logger.warn('Redis update failed, using in-memory', { executionId, error });
      }
    }

    // Fallback to in-memory
    const inMemoryResult = this.inMemoryFallback.get(executionId);
    if (inMemoryResult) {
      inMemoryResult.progress = progress;
    }
  }

  /**
   * Complete execution with result in Redis or in-memory
   */
  public async completeExecution(
    executionId: string,
    response: QueryResponse,
    success: boolean
  ): Promise<void> {
    // Try Redis first
    if (await this.isRedisAvailable()) {
      try {
        const data = await redisClient.get(this.getRedisKey(executionId));
        if (data) {
          const result: ExecutionResult = JSON.parse(data);
          result.result = response;
          if (result.status !== 'cancelled') {
            result.status = success ? 'completed' : 'failed';
          }
          result.endTime = Date.now();
          await redisClient.setEx(
            this.getRedisKey(executionId),
            this.REDIS_TTL_SECONDS,
            JSON.stringify(result)
          );
          return;
        }
      } catch (error) {
        logger.warn('Redis complete failed, using in-memory', { executionId, error });
      }
    }

    // Fallback to in-memory
    const inMemoryResult = this.inMemoryFallback.get(executionId);
    if (inMemoryResult) {
      inMemoryResult.result = response;
      if (inMemoryResult.status !== 'cancelled') {
        inMemoryResult.status = success ? 'completed' : 'failed';
      }
      inMemoryResult.endTime = Date.now();
    }
  }

  /**
   * Complete execution with error in Redis or in-memory
   */
  public async failExecution(executionId: string, errorMessage: string): Promise<void> {
    // Try Redis first
    if (await this.isRedisAvailable()) {
      try {
        const data = await redisClient.get(this.getRedisKey(executionId));
        if (data) {
          const result: ExecutionResult = JSON.parse(data);
          if (result.status !== 'cancelled') {
            result.status = 'failed';
            result.error = errorMessage;
            result.endTime = Date.now();
          }
          await redisClient.setEx(
            this.getRedisKey(executionId),
            this.REDIS_TTL_SECONDS,
            JSON.stringify(result)
          );
          return;
        }
      } catch (error) {
        logger.warn('Redis fail failed, using in-memory', { executionId, error });
      }
    }

    // Fallback to in-memory
    const inMemoryResult = this.inMemoryFallback.get(executionId);
    if (inMemoryResult) {
      if (inMemoryResult.status !== 'cancelled') {
        inMemoryResult.status = 'failed';
        inMemoryResult.error = errorMessage;
        inMemoryResult.endTime = Date.now();
      }
    }
  }

  /**
   * Release a client for an execution (in-memory, pod-specific)
   */
  public releaseClient(executionId: string, cloudKey: string): void {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.clients.delete(cloudKey);
      // Only delete the execution entry if all clients are released
      if (execution.clients.size === 0) {
        this.activeExecutions.delete(executionId);
      }
    }
  }

  /**
   * Check if execution was cancelled (in-memory, pod-specific)
   */
  public isCancelled(executionId: string): boolean {
    const execution = this.activeExecutions.get(executionId);
    return execution?.cancelled || false;
  }
}

export default ExecutionManager;
