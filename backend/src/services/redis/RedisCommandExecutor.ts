import RedisManagerPools from '../../config/redis-pools';
import { RedisCloudResult } from '../../types';
import logger from '../../utils/logger';

interface CommandDefinition {
  isWrite: boolean;
  execute: (client: any, args: Record<string, any>) => Promise<any>;
}

const COMMAND_MAP: Record<string, CommandDefinition> = {
  GET: {
    isWrite: false,
    execute: (client, args) => client.get(args.key),
  },
  MGET: {
    isWrite: false,
    execute: (client, args) => {
      const keys = String(args.key).split(',').map((k: string) => k.trim()).filter(Boolean);
      return client.mGet(keys);
    },
  },
  HGET: {
    isWrite: false,
    execute: (client, args) => client.hGet(args.key, args.field),
  },
  HGETALL: {
    isWrite: false,
    execute: (client, args) => client.hGetAll(args.key),
  },
  HKEYS: {
    isWrite: false,
    execute: (client, args) => client.hKeys(args.key),
  },
  LRANGE: {
    isWrite: false,
    execute: (client, args) => client.lRange(args.key, parseInt(args.start || '0'), parseInt(args.stop || '-1')),
  },
  SMEMBERS: {
    isWrite: false,
    execute: (client, args) => client.sMembers(args.key),
  },
  ZRANGE: {
    isWrite: false,
    execute: (client, args) => client.zRange(args.key, parseInt(args.start || '0'), parseInt(args.stop || '-1')),
  },
  TTL: {
    isWrite: false,
    execute: (client, args) => client.ttl(args.key),
  },
  TYPE: {
    isWrite: false,
    execute: (client, args) => client.type(args.key),
  },
  EXISTS: {
    isWrite: false,
    execute: (client, args) => client.exists(args.key),
  },
  XREAD: {
    isWrite: false,
    execute: (client, args) => {
      const streams = [{ key: args.key, id: args.id || '0-0' }];
      const options: any = {};
      if (args.count) options.COUNT = parseInt(args.count);
      return client.xRead(streams, options);
    },
  },
  XREADGROUP: {
    isWrite: false,
    execute: (client, args) => {
      const streams = [{ key: args.key, id: args.id || '>' }];
      const options: any = {};
      if (args.count) options.COUNT = parseInt(args.count);
      return client.xReadGroup(args.group, args.consumer, streams, options);
    },
  },
  SET: {
    isWrite: true,
    execute: (client, args) => {
      if (args.ex) {
        return client.setEx(args.key, parseInt(args.ex), args.value);
      }
      return client.set(args.key, args.value);
    },
  },
  DEL: {
    isWrite: true,
    execute: (client, args) => client.del(args.key),
  },
  HSET: {
    isWrite: true,
    execute: (client, args) => client.hSet(args.key, args.field, args.value),
  },
  EXPIRE: {
    isWrite: true,
    execute: (client, args) => client.expire(args.key, parseInt(args.seconds)),
  },
  LPUSH: {
    isWrite: true,
    execute: (client, args) => client.lPush(args.key, args.value),
  },
  RPUSH: {
    isWrite: true,
    execute: (client, args) => client.rPush(args.key, args.value),
  },
};

export const WRITE_COMMANDS = Object.entries(COMMAND_MAP)
  .filter(([, def]) => def.isWrite)
  .map(([cmd]) => cmd);

export const READ_COMMANDS = Object.entries(COMMAND_MAP)
  .filter(([, def]) => !def.isWrite)
  .map(([cmd]) => cmd);

export function getSupportedCommands(): string[] {
  return Object.keys(COMMAND_MAP);
}

export function isWriteCommand(command: string): boolean {
  return COMMAND_MAP[command.toUpperCase()]?.isWrite ?? false;
}

/**
 * Execute a raw Redis command string (MASTER only).
 * Parses the input into command + arguments and sends via sendCommand.
 */
export async function executeRawCommand(
  cloudName: string,
  rawCommand: string
): Promise<RedisCloudResult> {
  const startTime = Date.now();

  try {
    // Parse raw command into tokens (respecting quoted strings)
    const tokens = parseCommandTokens(rawCommand);
    if (tokens.length === 0) {
      return { success: false, error: 'Empty command', duration_ms: 0 };
    }

    const pools = RedisManagerPools.getInstance();
    const client = await pools.getClient(cloudName);

    // Redis cluster sendCommand signature: (firstKey, isReadonly, args)
    // firstKey is used for slot routing, tokens[1] is typically the key
    const firstKey = tokens.length > 1 ? tokens[1] : undefined;
    const cmd = tokens[0].toUpperCase();
    const isReadonly = !['SET', 'DEL', 'HSET', 'HDEL', 'EXPIRE', 'LPUSH', 'RPUSH',
      'SADD', 'SREM', 'ZADD', 'ZREM', 'UNLINK', 'INCR', 'DECR', 'APPEND',
      'SETEX', 'PSETEX', 'MSET', 'XADD', 'XTRIM'].includes(cmd);

    const result = await (client as any).sendCommand(firstKey, isReadonly, tokens);

    const duration_ms = Date.now() - startTime;

    logger.info('Redis raw command executed', {
      cloud: cloudName,
      command: cmd,
      duration_ms,
    });

    return { success: true, data: result, duration_ms };
  } catch (error: any) {
    const duration_ms = Date.now() - startTime;

    logger.error('Redis raw command failed', {
      cloud: cloudName,
      rawCommand: rawCommand.substring(0, 200),
      error: error.message,
      duration_ms,
    });

    return { success: false, error: error.message, duration_ms };
  }
}

/**
 * Parse a raw command string into tokens, respecting double-quoted strings.
 * e.g. 'SET "my key" "hello world"' → ['SET', 'my key', 'hello world']
 */
function parseCommandTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' && (i === 0 || input[i - 1] !== '\\')) {
      inQuotes = !inQuotes;
    } else if (ch === ' ' && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export async function executeCommand(
  cloudName: string,
  command: string,
  args: Record<string, any>
): Promise<RedisCloudResult> {
  const upperCommand = command.toUpperCase();
  const definition = COMMAND_MAP[upperCommand];

  if (!definition) {
    return {
      success: false,
      error: `Unsupported command: ${command}. Supported: ${Object.keys(COMMAND_MAP).join(', ')}`,
      duration_ms: 0,
    };
  }

  const startTime = Date.now();

  try {
    const pools = RedisManagerPools.getInstance();
    const client = await pools.getClient(cloudName);
    const result = await definition.execute(client, args);

    const duration_ms = Date.now() - startTime;

    logger.info(`Redis command executed`, {
      cloud: cloudName,
      command: upperCommand,
      key: args.key,
      duration_ms,
    });

    return {
      success: true,
      data: result,
      duration_ms,
    };
  } catch (error: any) {
    const duration_ms = Date.now() - startTime;

    logger.error(`Redis command failed`, {
      cloud: cloudName,
      command: upperCommand,
      key: args.key,
      error: error.message,
      duration_ms,
    });

    return {
      success: false,
      error: error.message,
      duration_ms,
    };
  }
}
