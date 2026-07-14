import { v4 as uuidv4 } from 'uuid';
import logger from '../../utils/logger';
import DatabasePools from '../../config/database';
import { ExecutionManager } from './ExecutionManager';
import { QueryResponse } from '../../types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_REGEX = /^\d+$/;
// Safe string: alphanumeric, hyphens, underscores, dots only — no SQL metacharacters
const SAFE_STRING_REGEX = /^[a-zA-Z0-9_\-\.@]+$/;

export interface CsvBatchRequest {
  queryTemplate: string;
  ids: string[];
  database: string;
  batchSize?: number;
  sleepMs?: number;
  dryRun?: boolean;
  stopOnError?: boolean;
  pgSchema?: string;
}

export interface BatchResult {
  batchIndex: number;
  idsCount: number;
  rowsAffected: number;
  success: boolean;
  error?: string;
  durationMs: number;
}

export interface CsvBatchSummary {
  totalIds: number;
  uniqueIds: number;
  totalBatches: number;
  completedBatches: number;
  failedBatches: number;
  totalRowsAffected: number;
  dryRun: boolean;
  dryRunQueries?: string[];
  batchResults?: BatchResult[];
  failedIds?: string[];           // IDs from all failed batches (capped at 50k)
  failedIdsTruncated?: boolean;   // true if >50k failed IDs were truncated
}

class CsvBatchService {
  private executionManager: ExecutionManager;

  constructor() {
    this.executionManager = new ExecutionManager();
  }

  public getExecutionStatus(executionId: string) {
    return this.executionManager.getExecutionStatus(executionId);
  }

  public async cancelExecution(executionId: string): Promise<boolean> {
    return this.executionManager.markAsCancelled(executionId);
  }

  public async startBatchExecution(
    request: CsvBatchRequest,
    userId?: string
  ): Promise<{ executionId: string; totalIds: number; uniqueIds: number; totalBatches: number }> {
    if (!request.queryTemplate.includes('{id}')) {
      throw new Error('Query template must contain {id} placeholder');
    }

    const { ids: validIds, idType } = this.validateAndDeduplicateIds(request.ids);
    const batchSize = Math.min(Math.max(request.batchSize || 1000, 1), 10000);
    const batches = this.chunkArray(validIds, batchSize);

    const executionId = uuidv4();
    await this.executionManager.initializeExecution(executionId, userId);
    await this.executionManager.updateProgress(executionId, 0, batches.length);

    if (request.dryRun) {
      // For dry run: generate first 2 batch queries and complete immediately
      const dryRunQueries = batches.slice(0, 2).map(batch => {
        const idList = this.buildIdList(batch, idType);
        return request.queryTemplate.replace('{id}', idList);
      });

      const summary: CsvBatchSummary = {
        totalIds: request.ids.length,
        uniqueIds: validIds.length,
        totalBatches: batches.length,
        completedBatches: 0,
        failedBatches: 0,
        totalRowsAffected: 0,
        dryRun: true,
        dryRunQueries,
      };

      const response: QueryResponse = {
        id: executionId,
        success: true,
        csvBatch: summary,
      };
      await this.executionManager.completeExecution(executionId, response, true);
      this.executionManager.completeActiveExecution(executionId);
    } else {
      this.executeBatchAsync(executionId, request, validIds, idType, batches, userId).catch(err => {
        logger.error('CSV batch execution failed unexpectedly', { executionId, error: err.message });
        this.executionManager.failExecution(executionId, err.message);
        this.executionManager.completeActiveExecution(executionId);
      });
    }

    return {
      executionId,
      totalIds: request.ids.length,
      uniqueIds: validIds.length,
      totalBatches: batches.length,
    };
  }

  private async executeBatchAsync(
    executionId: string,
    request: CsvBatchRequest,
    ids: string[],
    idType: 'uuid' | 'integer' | 'string',
    batches: string[][],
    userId?: string
  ): Promise<void> {
    const { database, sleepMs = 100, pgSchema, stopOnError = false } = request;
    const dbPools = DatabasePools.getInstance();

    // CSV batch runs on this database's own primary cloud
    const primaryCloud = dbPools.getPrimaryCloudForDatabase(database);

    const QUERY_TIMEOUT_MS = 15000;
    const FAILED_IDS_CAP = 50000;

    const batchResults: BatchResult[] = [];
    const failedIds: string[] = [];
    let failedIdsTruncated = false;
    let totalRowsAffected = 0;
    let failedBatches = 0;

    for (let i = 0; i < batches.length; i++) {
      if (await this.executionManager.isCancelled(executionId)) {
        logger.info('CSV batch cancelled by user', { executionId, completedBatches: i });
        break;
      }

      const batch = batches[i];
      const idList = this.buildIdList(batch, idType);
      const sql = request.queryTemplate.replace('{id}', idList);
      const batchStart = Date.now();
      let batchSuccess = true;
      let batchError: string | undefined;
      let batchRowsAffected = 0;

      const pool = dbPools.getPoolByName(primaryCloud, database);
      if (!pool) {
        batchSuccess = false;
        batchError = `Pool not found for ${primaryCloud}/${database}`;
      } else {
        try {
          const client = await pool.connect();
          try {
            if (pgSchema) {
              await client.query(`SET search_path TO ${pgSchema}, public`);
            }
            const result = await Promise.race([
              client.query(sql),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Query timeout after ${QUERY_TIMEOUT_MS}ms`)), QUERY_TIMEOUT_MS)
              ),
            ]);
            batchRowsAffected = (result as any).rowCount || 0;
          } finally {
            client.release();
          }
        } catch (err: any) {
          batchSuccess = false;
          batchError = err.message;
          logger.warn(`CSV batch ${i + 1}/${batches.length} failed on ${primaryCloud}/${database}`, {
            executionId,
            batchIndex: i,
            error: err.message,
          });
        }
      }

      const batchResult: BatchResult = {
        batchIndex: i,
        idsCount: batch.length,
        rowsAffected: batchRowsAffected,
        success: batchSuccess,
        error: batchError,
        durationMs: Date.now() - batchStart,
      };

      batchResults.push(batchResult);
      totalRowsAffected += batchRowsAffected;

      if (!batchSuccess) {
        failedBatches++;
        // Accumulate failed IDs (capped at FAILED_IDS_CAP to avoid Redis overflow)
        if (!failedIdsTruncated) {
          const remaining = FAILED_IDS_CAP - failedIds.length;
          if (batch.length <= remaining) {
            failedIds.push(...batch);
          } else {
            failedIds.push(...batch.slice(0, remaining));
            failedIdsTruncated = true;
            logger.warn('Failed IDs truncated at 50k cap', { executionId });
          }
        }
      }

      if (!batchSuccess && stopOnError) {
        logger.warn(`CSV batch stopped at batch ${i + 1} due to error (stopOnError=true)`, {
          executionId,
          batchIndex: i,
          error: batchError,
        });
        break;
      }

      await this.executionManager.updateProgress(executionId, i + 1, batches.length);

      // Save partial results (keep last 100 batch results to avoid huge Redis payload)
      const partialSummary: CsvBatchSummary = {
        totalIds: ids.length,
        uniqueIds: ids.length,
        totalBatches: batches.length,
        completedBatches: i + 1,
        failedBatches,
        totalRowsAffected,
        dryRun: false,
        batchResults: batchResults.slice(-100),
        failedIds,
        failedIdsTruncated,
      };
      await this.executionManager.savePartialResults(executionId, {
        id: executionId,
        success: false,
        csvBatch: partialSummary,
      });

      if (i < batches.length - 1 && sleepMs > 0) {
        await this.sleep(sleepMs);
      }
    }

    const overallSuccess = failedBatches === 0;
    const wasCancelled = await this.executionManager.isCancelled(executionId);

    const finalSummary: CsvBatchSummary = {
      totalIds: ids.length,
      uniqueIds: ids.length,
      totalBatches: batches.length,
      completedBatches: batchResults.length,
      failedBatches,
      totalRowsAffected,
      dryRun: false,
      batchResults: batchResults.slice(-100),
      failedIds,
      failedIdsTruncated,
    };

    const response: QueryResponse = {
      id: executionId,
      success: overallSuccess && !wasCancelled,
      csvBatch: finalSummary,
    };

    await this.executionManager.completeExecution(executionId, response, overallSuccess && !wasCancelled);
    this.executionManager.completeActiveExecution(executionId);

    logger.info('CSV batch execution complete', {
      executionId,
      totalBatches: batches.length,
      completedBatches: batchResults.length,
      failedBatches,
      totalRowsAffected,
      wasCancelled,
    });
  }

  private validateAndDeduplicateIds(rawIds: string[]): {
    ids: string[];
    idType: 'uuid' | 'integer' | 'string';
  } {
    if (rawIds.length === 0) {
      throw new Error('No IDs provided');
    }

    const sample = rawIds.find(id => id.trim() !== '');
    if (!sample) throw new Error('All IDs are empty');

    let idType: 'uuid' | 'integer' | 'string';
    if (UUID_REGEX.test(sample.trim())) {
      idType = 'uuid';
    } else if (INT_REGEX.test(sample.trim())) {
      idType = 'integer';
    } else {
      idType = 'string';
    }

    const validIds: string[] = [];
    const seen = new Set<string>();
    const invalidIds: string[] = [];

    for (const raw of rawIds) {
      const id = raw.trim();
      if (!id) continue;

      let isValid: boolean;
      if (idType === 'uuid') {
        isValid = UUID_REGEX.test(id);
      } else if (idType === 'integer') {
        isValid = INT_REGEX.test(id);
      } else {
        isValid = SAFE_STRING_REGEX.test(id);
      }

      if (!isValid) {
        invalidIds.push(id);
        if (invalidIds.length > 5) break; // Bail early for reporting
        continue;
      }

      const normalized = idType === 'uuid' ? id.toLowerCase() : id;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        validIds.push(normalized);
      }
    }

    if (invalidIds.length > 0) {
      throw new Error(
        `${invalidIds.length} IDs have invalid format (expected ${idType}). ` +
          `First invalid: ${invalidIds.slice(0, 3).join(', ')}`
      );
    }

    if (validIds.length === 0) {
      throw new Error('No valid IDs found after filtering');
    }

    return { ids: validIds, idType };
  }

  private buildIdList(ids: string[], idType: 'uuid' | 'integer' | 'string'): string {
    if (idType === 'integer') {
      return `(${ids.join(',')})`;
    }
    // UUID or safe string: wrap in single quotes
    const quoted = ids.map(id => `'${id}'`);
    return `(${quoted.join(',')})`;
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default new CsvBatchService();
