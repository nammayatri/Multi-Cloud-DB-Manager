import { v4 as uuidv4 } from 'uuid';
import RedisManagerPools from '../../config/redis-pools';
import { executeCommand, isWriteCommand, executeRawCommand } from './RedisCommandExecutor';
import { startScan, getScanStatus as getScanStatusFromStore, cancelScan as cancelScanInStore } from './RedisScanService';
import { RedisCommandRequest, RedisCommandResponse, RedisScanRequest, RedisScanResponse } from '../../types';
import logger from '../../utils/logger';

// Max raw command length to prevent memory exhaustion
const MAX_RAW_COMMAND_LENGTH = 10000;

// Patterns that are too broad / dangerous — blocked for ALL users
const BLOCKED_KEY_PATTERNS = [
  /^\*$/,          // exactly "*"
  /^\*\*$/,        // exactly "**"
  /^\?$/,          // single char wildcard "?"
];

// Commands blocked for ALL users including MASTER (even in RAW mode)
// These are dangerous at the infrastructure level and should never be run from the UI
const BLOCKED_COMMANDS_ALWAYS = new Set([
  // Server destruction / shutdown
  'FLUSHDB', 'FLUSHALL', 'SHUTDOWN', 'DEBUG',
  // Replication / topology changes
  'SLAVEOF', 'REPLICAOF', 'FAILOVER',
  // Cluster management (could break the cluster)
  'CLUSTER',
  // Lua scripting — can bypass ALL command restrictions via redis.call()
  'EVAL', 'EVALSHA', 'EVALRO', 'EVALSHA_RO',
  'SCRIPT', 'FUNCTION', 'FCALL', 'FCALL_RO',
  // Module loading — arbitrary code execution
  'MODULE',
  // Data exfiltration — move keys to external server
  'MIGRATE',
  // ACL / permission changes
  'ACL',
  // Config changes
  'CONFIG',
  // Blocking commands — will hang the connection pool
  'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE',
  'MONITOR', 'WAIT', 'WAITAOF',
  'BLPOP', 'BRPOP', 'BLMOVE', 'BRPOPLPUSH',
  'BLMPOP', 'BZPOPMIN', 'BZPOPMAX', 'BZMPOP',
  // Database switching (breaks cluster mode)
  'SELECT', 'SWAPDB',
  // Transaction commands (cluster issues + could hold state)
  'MULTI', 'EXEC', 'DISCARD', 'WATCH', 'UNWATCH',
  // Connection manipulation
  'CLIENT', 'RESET', 'HELLO', 'AUTH', 'QUIT',
  // Disk operations
  'BGSAVE', 'BGREWRITEAOF', 'SAVE',
  // Dangerous key enumeration
  'KEYS',
]);

// Commands blocked in structured mode but allowed in RAW (MASTER only)
// These are less dangerous but shouldn't be in the structured dropdown
const BLOCKED_COMMANDS_STRUCTURED = ['KEYS'];

class RedisManagerService {
  /**
   * Execute a Redis command across specified clouds
   */
  async executeCommand(request: RedisCommandRequest, userRole: string): Promise<RedisCommandResponse> {
    const pools = RedisManagerPools.getInstance();
    const allClouds = pools.getAllCloudNames();
    const { command, args, cloud } = request;
    const upperCommand = command.toUpperCase();

    // Determine target clouds
    const targetClouds = cloud === 'both' ? allClouds : [cloud];

    // Validate clouds
    for (const c of targetClouds) {
      if (!allClouds.includes(c)) {
        throw new Error(`Invalid cloud: ${c}. Available: ${allClouds.join(', ')}`);
      }
    }

    // Handle RAW command — MASTER only
    if (upperCommand === 'RAW') {
      if (userRole !== 'MASTER') {
        throw new Error('Only MASTER role can execute raw Redis commands');
      }

      const rawCmd = String(args.rawCommand || '').trim();
      if (!rawCmd) {
        throw new Error('Raw command string is required');
      }

      // Input sanitization
      if (rawCmd.length > MAX_RAW_COMMAND_LENGTH) {
        throw new Error(`Raw command too long (max ${MAX_RAW_COMMAND_LENGTH} chars)`);
      }
      if (/\0/.test(rawCmd)) {
        throw new Error('Null bytes are not allowed in commands');
      }

      // Extract the command name and check against blocked list
      const firstToken = rawCmd.split(/\s+/)[0]?.toUpperCase();
      if (!firstToken) {
        throw new Error('Empty command');
      }

      if (BLOCKED_COMMANDS_ALWAYS.has(firstToken)) {
        logger.warn('Blocked dangerous Redis RAW command', {
          user: userRole,
          command: firstToken,
          rawCommand: rawCmd.substring(0, 200),
        });
        throw new Error(
          `Command "${firstToken}" is blocked for security reasons. ` +
          `This includes commands that can destroy data, execute scripts, hang connections, or modify cluster topology.`
        );
      }

      const id = uuidv4();
      const response: RedisCommandResponse = {
        id,
        success: true,
        command: 'RAW',
      };

      const results = await Promise.all(
        targetClouds.map(async (cloudName) => {
          const result = await executeRawCommand(cloudName, rawCmd);
          return { cloudName, result };
        })
      );

      let anySuccess = false;
      for (const { cloudName, result } of results) {
        response[cloudName] = result;
        if (result.success) anySuccess = true;
      }
      response.success = anySuccess;

      logger.info('Redis RAW command executed', {
        id,
        rawCommand: rawCmd.substring(0, 100),
        clouds: targetClouds,
        success: response.success,
      });

      return response;
    }

    // Block dangerous commands for all users
    if (BLOCKED_COMMANDS_ALWAYS.has(upperCommand) || BLOCKED_COMMANDS_STRUCTURED.includes(upperCommand)) {
      throw new Error(`Command "${upperCommand}" is not allowed.`);
    }

    // Input sanitization for structured commands
    const keyArg = String(args.key || '');
    if (keyArg.length > 0 && /\0/.test(keyArg)) {
      throw new Error('Null bytes are not allowed in key names');
    }
    const valueArg = String(args.value || '');
    if (valueArg.length > 0 && /\0/.test(valueArg)) {
      throw new Error('Null bytes are not allowed in values');
    }

    // Block wildcard-only key arguments for ALL users
    if (args.key && BLOCKED_KEY_PATTERNS.some((re) => re.test(String(args.key).trim()))) {
      throw new Error('Wildcard-only key patterns (e.g., "*") are blocked. Use a specific key or SCAN with a pattern.');
    }

    // Check write permissions
    if (isWriteCommand(command) && userRole === 'READER') {
      throw new Error('READER role cannot execute write commands');
    }

    const id = uuidv4();
    const response: RedisCommandResponse = {
      id,
      success: true,
      command: upperCommand,
    };

    // Execute on all target clouds concurrently
    const results = await Promise.all(
      targetClouds.map(async (cloudName) => {
        const result = await executeCommand(cloudName, command, args);
        return { cloudName, result };
      })
    );

    // Aggregate results
    let anySuccess = false;
    for (const { cloudName, result } of results) {
      response[cloudName] = result;
      if (result.success) anySuccess = true;
    }

    response.success = anySuccess;

    logger.info('Redis command executed', {
      id,
      command: upperCommand,
      clouds: targetClouds,
      success: response.success,
    });

    return response;
  }

  /**
   * Start an async SCAN operation
   */
  async startScan(request: RedisScanRequest, userRole: string): Promise<{ executionId: string }> {
    const { pattern, cloud, action, scanCount } = request;

    // Input sanitization
    const trimmedPattern = pattern.trim();
    if (/\0/.test(trimmedPattern)) {
      throw new Error('Null bytes are not allowed in patterns');
    }
    if (trimmedPattern.length > 500) {
      throw new Error('Pattern too long (max 500 chars)');
    }

    // Block wildcard-only SCAN patterns for ALL users
    if (BLOCKED_KEY_PATTERNS.some((re) => re.test(trimmedPattern))) {
      throw new Error('Wildcard-only patterns (e.g., "*") are blocked. Use a more specific pattern like "prefix:*".');
    }

    // Check delete permissions
    if (action === 'delete' && userRole === 'READER') {
      throw new Error('READER role cannot delete keys');
    }

    const executionId = uuidv4();

    // Validate clouds
    const pools = RedisManagerPools.getInstance();
    const allClouds = pools.getAllCloudNames();
    if (cloud !== 'both' && !allClouds.includes(cloud)) {
      throw new Error(`Invalid cloud: ${cloud}. Available: ${allClouds.join(', ')}`);
    }

    // Start async scan
    await startScan(executionId, pattern, cloud, action, scanCount);

    logger.info('Redis SCAN started', {
      executionId,
      pattern,
      cloud,
      action,
    });

    return { executionId };
  }

  /**
   * Get SCAN operation status
   */
  async getScanStatus(executionId: string): Promise<RedisScanResponse | null> {
    return getScanStatusFromStore(executionId);
  }

  /**
   * Cancel a running SCAN operation
   */
  async cancelScan(executionId: string): Promise<boolean> {
    const cancelled = await cancelScanInStore(executionId);

    if (cancelled) {
      logger.info('Redis SCAN cancel requested', { executionId });
    }

    return cancelled;
  }
}

export default new RedisManagerService();
