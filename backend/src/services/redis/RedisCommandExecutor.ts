import RedisManagerPools from '../../config/redis-pools';
import { RedisCloudResult } from '../../types';
import logger from '../../utils/logger';

interface CommandDefinition {
  isWrite: boolean;
  execute: (client: any, args: Record<string, any>) => Promise<any>;
}

const COMMAND_MAP: Record<string, CommandDefinition> = {
  // ── Key ──────────────────────────────────────────────────────
  DEL: {
    isWrite: true,
    execute: (client, args) => client.del(args.key),
  },
  EXISTS: {
    isWrite: false,
    execute: (client, args) => client.exists(args.key),
  },
  EXPIRE: {
    isWrite: true,
    execute: (client, args) => client.expire(args.key, parseInt(args.seconds)),
  },
  TTL: {
    isWrite: false,
    execute: (client, args) => client.ttl(args.key),
  },
  TYPE: {
    isWrite: false,
    execute: (client, args) => client.type(args.key),
  },

  // ── String ───────────────────────────────────────────────────
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
  SET: {
    isWrite: true,
    execute: (client, args) => {
      if (args.ex) {
        return client.setEx(args.key, parseInt(args.ex), args.value);
      }
      return client.set(args.key, args.value);
    },
  },
  SETNX: {
    isWrite: true,
    execute: (client, args) => client.setNX(args.key, args.value),
  },
  SETEX: {
    isWrite: true,
    execute: (client, args) => client.setEx(args.key, parseInt(args.seconds), args.value),
  },
  MSET: {
    isWrite: true,
    execute: (client, args) => {
      let pairs: Record<string, any>;
      try {
        pairs = JSON.parse(args.pairs);
      } catch {
        throw new Error('Invalid JSON for MSET pairs. Expected format: {"key1":"val1","key2":"val2"}');
      }
      const arr: string[] = [];
      for (const [k, v] of Object.entries(pairs)) {
        arr.push(k, String(v));
      }
      return client.mSet(arr);
    },
  },
  INCR: {
    isWrite: true,
    execute: (client, args) => client.incr(args.key),
  },
  INCRBY: {
    isWrite: true,
    execute: (client, args) => client.incrBy(args.key, parseInt(args.increment)),
  },
  DECR: {
    isWrite: true,
    execute: (client, args) => client.decr(args.key),
  },
  DECRBY: {
    isWrite: true,
    execute: (client, args) => client.decrBy(args.key, parseInt(args.decrement)),
  },
  INCRBYFLOAT: {
    isWrite: true,
    execute: (client, args) => client.incrByFloat(args.key, parseFloat(args.increment)),
  },

  // ── Hash ─────────────────────────────────────────────────────
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
  HMGET: {
    isWrite: false,
    execute: (client, args) => {
      const fields = String(args.fields).split(',').map((f: string) => f.trim()).filter(Boolean);
      return client.hmGet(args.key, fields);
    },
  },
  HSET: {
    isWrite: true,
    execute: (client, args) => client.hSet(args.key, args.field, args.value),
  },
  HDEL: {
    isWrite: true,
    execute: (client, args) => client.hDel(args.key, args.field),
  },

  // ── List ─────────────────────────────────────────────────────
  LRANGE: {
    isWrite: false,
    execute: (client, args) => client.lRange(args.key, parseInt(args.start || '0'), parseInt(args.stop || '-1')),
  },
  LLEN: {
    isWrite: false,
    execute: (client, args) => client.lLen(args.key),
  },
  LPUSH: {
    isWrite: true,
    execute: (client, args) => client.lPush(args.key, args.value),
  },
  RPUSH: {
    isWrite: true,
    execute: (client, args) => client.rPush(args.key, args.value),
  },
  RPOP: {
    isWrite: true,
    execute: (client, args) => client.rPop(args.key),
  },
  LTRIM: {
    isWrite: true,
    execute: (client, args) => client.lTrim(args.key, parseInt(args.start), parseInt(args.stop)),
  },
  LREM: {
    isWrite: true,
    execute: (client, args) => client.lRem(args.key, parseInt(args.count), args.element),
  },

  // ── Set ──────────────────────────────────────────────────────
  SMEMBERS: {
    isWrite: false,
    execute: (client, args) => client.sMembers(args.key),
  },
  SISMEMBER: {
    isWrite: false,
    execute: (client, args) => client.sIsMember(args.key, args.member),
  },
  SADD: {
    isWrite: true,
    execute: (client, args) => client.sAdd(args.key, args.member),
  },
  SREM: {
    isWrite: true,
    execute: (client, args) => client.sRem(args.key, args.member),
  },
  SMOVE: {
    isWrite: true,
    execute: (client, args) => client.sMove(args.source, args.destination, args.member),
  },

  // ── Sorted Set ───────────────────────────────────────────────
  ZRANGE: {
    isWrite: false,
    execute: (client, args) => client.zRange(args.key, parseInt(args.start || '0'), parseInt(args.stop || '-1')),
  },
  ZREVRANGE: {
    isWrite: false,
    execute: (client, args) => client.zRange(args.key, parseInt(args.start || '0'), parseInt(args.stop || '-1'), { REV: true }),
  },
  ZRANGEBYSCORE: {
    isWrite: false,
    execute: (client, args) => {
      // min/max kept as strings to support -inf, +inf, and exclusive syntax like "(1.5"
      const min = String(args.min);
      const max = String(args.max);
      const options: any = {};
      if (args.offset !== undefined && args.count !== undefined) {
        options.LIMIT = { offset: parseInt(args.offset), count: parseInt(args.count) };
      }
      return Object.keys(options).length > 0
        ? client.zRangeByScore(args.key, min, max, options)
        : client.zRangeByScore(args.key, min, max);
    },
  },
  ZRANGEWITHSCORES: {
    isWrite: false,
    execute: (client, args) => client.zRangeWithScores(args.key, parseInt(args.start || '0'), parseInt(args.stop || '-1')),
  },
  ZREVRANGEWITHSCORES: {
    isWrite: false,
    execute: (client, args) => client.zRangeWithScores(args.key, parseInt(args.start || '0'), parseInt(args.stop || '-1'), { REV: true }),
  },
  ZCARD: {
    isWrite: false,
    execute: (client, args) => client.zCard(args.key),
  },
  ZCOUNT: {
    isWrite: false,
    execute: (client, args) => client.zCount(args.key, String(args.min), String(args.max)),
  },
  ZSCORE: {
    isWrite: false,
    execute: (client, args) => client.zScore(args.key, args.member),
  },
  ZRANK: {
    isWrite: false,
    execute: (client, args) => client.zRank(args.key, args.member),
  },
  ZREVRANK: {
    isWrite: false,
    execute: (client, args) => client.zRevRank(args.key, args.member),
  },
  ZADD: {
    isWrite: true,
    execute: (client, args) => client.zAdd(args.key, [{ score: parseFloat(args.score), value: args.member }]),
  },
  ZREM: {
    isWrite: true,
    execute: (client, args) => client.zRem(args.key, args.member),
  },
  ZINCRBY: {
    isWrite: true,
    execute: (client, args) => client.zIncrBy(args.key, parseFloat(args.increment), args.member),
  },
  ZREMRANGEBYSCORE: {
    isWrite: true,
    execute: (client, args) => client.zRemRangeByScore(args.key, String(args.min), String(args.max)),
  },

  // ── Stream ───────────────────────────────────────────────────
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
  XLEN: {
    isWrite: false,
    execute: (client, args) => client.xLen(args.key),
  },
  XREVRANGE: {
    isWrite: false,
    execute: (client, args) => {
      const options: any = {};
      if (args.count) options.COUNT = parseInt(args.count);
      return Object.keys(options).length > 0
        ? client.xRevRange(args.key, args.start || '+', args.end || '-', options)
        : client.xRevRange(args.key, args.start || '+', args.end || '-');
    },
  },
  XINFO_GROUPS: {
    isWrite: false,
    execute: (client, args) => client.xInfoGroups(args.key),
  },
  XADD: {
    isWrite: true,
    execute: (client, args) => {
      let fields: Record<string, string>;
      try {
        fields = JSON.parse(args.fields);
      } catch {
        throw new Error('Invalid JSON for XADD fields. Expected format: {"field1":"val1","field2":"val2"}');
      }
      return client.xAdd(args.key, args.id || '*', fields);
    },
  },
  XDEL: {
    isWrite: true,
    execute: (client, args) => client.xDel(args.key, args.id),
  },
  XACK: {
    isWrite: true,
    execute: (client, args) => client.xAck(args.key, args.group, args.id),
  },
  XGROUP_CREATE: {
    isWrite: true,
    execute: (client, args) => client.xGroupCreate(args.key, args.group, args.id || '$', { MKSTREAM: true }),
  },

  // ── Geo ──────────────────────────────────────────────────────
  GEOADD: {
    isWrite: true,
    execute: (client, args) => client.geoAdd(args.key, {
      longitude: parseFloat(args.longitude),
      latitude: parseFloat(args.latitude),
      member: args.member,
    }),
  },
  GEOSEARCH: {
    isWrite: false,
    execute: (client, args) => client.geoSearch(
      args.key,
      { longitude: parseFloat(args.longitude), latitude: parseFloat(args.latitude) },
      { radius: parseFloat(args.radius), unit: args.unit || 'km' },
    ),
  },

  // ── Utility ──────────────────────────────────────────────────
  PING: {
    isWrite: false,
    execute: (client) => client.ping(),
  },
  PUBLISH: {
    isWrite: true,
    execute: (client, args) => client.publish(args.channel, args.message),
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
    const isReadonly = !WRITE_COMMAND_SET.has(cmd);

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

// Set of all known write commands for RAW mode isReadonly routing
const WRITE_COMMAND_SET = new Set([
  'SET', 'SETNX', 'SETEX', 'PSETEX', 'MSET', 'MSETNX', 'APPEND',
  'INCR', 'INCRBY', 'INCRBYFLOAT', 'DECR', 'DECRBY',
  'DEL', 'UNLINK', 'EXPIRE', 'EXPIREAT', 'PEXPIRE', 'PEXPIREAT', 'PERSIST', 'RENAME', 'RENAMENX',
  'HSET', 'HSETNX', 'HMSET', 'HDEL', 'HINCRBY', 'HINCRBYFLOAT',
  'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LSET', 'LINSERT', 'LTRIM', 'LREM',
  'RPOPLPUSH', 'LMOVE', 'LPOS',
  'SADD', 'SREM', 'SPOP', 'SMOVE', 'SDIFFSTORE', 'SINTERSTORE', 'SUNIONSTORE',
  'ZADD', 'ZREM', 'ZINCRBY', 'ZREMRANGEBYRANK', 'ZREMRANGEBYSCORE', 'ZREMRANGEBYLEX',
  'ZPOPMIN', 'ZPOPMAX', 'ZRANGESTORE', 'ZDIFFSTORE', 'ZINTERSTORE', 'ZUNIONSTORE',
  'XADD', 'XDEL', 'XACK', 'XTRIM', 'XGROUP',
  'GEOADD',
  'PUBLISH',
  'COPY', 'MOVE', 'SORT',
]);

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
