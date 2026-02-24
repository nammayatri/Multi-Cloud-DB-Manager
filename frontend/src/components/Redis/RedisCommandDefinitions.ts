import type { RedisCommandDefinition } from '../../types';

/**
 * All structured Redis commands grouped by category.
 * Read commands listed first within each category, then write commands.
 */
export const ALL_STRUCTURED_COMMANDS: RedisCommandDefinition[] = [
  // ── Key ──────────────────────────────────────────────────────
  {
    command: 'EXISTS', label: 'EXISTS', category: 'Key', isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'TTL', label: 'TTL', category: 'Key', isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'TYPE', label: 'TYPE', category: 'Key', isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'DEL', label: 'DEL', category: 'Key', isWrite: true,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'EXPIRE', label: 'EXPIRE', category: 'Key', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'seconds', label: 'Seconds', required: true },
    ],
  },

  // ── String ───────────────────────────────────────────────────
  {
    command: 'GET', label: 'GET', category: 'String', isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'MGET', label: 'MGET', category: 'String', isWrite: false,
    fields: [{ name: 'key', label: 'Keys (comma-separated)', required: true }],
  },
  {
    command: 'SET', label: 'SET', category: 'String', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'value', label: 'Value', required: true },
      { name: 'ex', label: 'Expire (sec)', required: false },
    ],
  },
  {
    command: 'SETNX', label: 'SETNX', category: 'String', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'value', label: 'Value', required: true },
    ],
  },
  {
    command: 'SETEX', label: 'SETEX', category: 'String', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'seconds', label: 'Seconds', required: true },
      { name: 'value', label: 'Value', required: true },
    ],
  },
  {
    command: 'MSET', label: 'MSET', category: 'String', isWrite: true,
    fields: [{ name: 'pairs', label: 'Key-Value pairs (JSON: {"k1":"v1","k2":"v2"})', required: true }],
  },
  {
    command: 'INCR', label: 'INCR', category: 'String', isWrite: true,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'INCRBY', label: 'INCRBY', category: 'String', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'increment', label: 'Increment', required: true },
    ],
  },
  {
    command: 'DECR', label: 'DECR', category: 'String', isWrite: true,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'DECRBY', label: 'DECRBY', category: 'String', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'decrement', label: 'Decrement', required: true },
    ],
  },
  {
    command: 'INCRBYFLOAT', label: 'INCRBYFLOAT', category: 'String', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'increment', label: 'Increment (float)', required: true },
    ],
  },

  // ── Hash ─────────────────────────────────────────────────────
  {
    command: 'HGET', label: 'HGET', category: 'Hash', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'field', label: 'Field', required: true },
    ],
  },
  {
    command: 'HGETALL', label: 'HGETALL', category: 'Hash', isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'HKEYS', label: 'HKEYS', category: 'Hash', isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'HMGET', label: 'HMGET', category: 'Hash', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'fields', label: 'Fields (comma-separated)', required: true },
    ],
  },
  {
    command: 'HSET', label: 'HSET', category: 'Hash', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'field', label: 'Field', required: true },
      { name: 'value', label: 'Value', required: true },
    ],
  },
  {
    command: 'HDEL', label: 'HDEL', category: 'Hash', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'field', label: 'Field', required: true },
    ],
  },

  // ── List ─────────────────────────────────────────────────────
  {
    command: 'LRANGE', label: 'LRANGE', category: 'List', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'start', label: 'Start', required: false, default: '0' },
      { name: 'stop', label: 'Stop', required: false, default: '-1' },
    ],
  },
  {
    command: 'LLEN', label: 'LLEN', category: 'List', isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'LPUSH', label: 'LPUSH', category: 'List', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'value', label: 'Value', required: true },
    ],
  },
  {
    command: 'RPUSH', label: 'RPUSH', category: 'List', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'value', label: 'Value', required: true },
    ],
  },
  {
    command: 'RPOP', label: 'RPOP', category: 'List', isWrite: true,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'LTRIM', label: 'LTRIM', category: 'List', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'start', label: 'Start', required: true },
      { name: 'stop', label: 'Stop', required: true },
    ],
  },
  {
    command: 'LREM', label: 'LREM', category: 'List', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'count', label: 'Count', required: true },
      { name: 'element', label: 'Element', required: true },
    ],
  },

  // ── Set ──────────────────────────────────────────────────────
  {
    command: 'SMEMBERS', label: 'SMEMBERS', category: 'Set', isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'SISMEMBER', label: 'SISMEMBER', category: 'Set', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'member', label: 'Member', required: true },
    ],
  },
  {
    command: 'SADD', label: 'SADD', category: 'Set', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'member', label: 'Member', required: true },
    ],
  },
  {
    command: 'SREM', label: 'SREM', category: 'Set', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'member', label: 'Member', required: true },
    ],
  },
  {
    command: 'SMOVE', label: 'SMOVE', category: 'Set', isWrite: true,
    fields: [
      { name: 'source', label: 'Source Key', required: true },
      { name: 'destination', label: 'Destination Key', required: true },
      { name: 'member', label: 'Member', required: true },
    ],
  },

  // ── Sorted Set ───────────────────────────────────────────────
  {
    command: 'ZRANGE', label: 'ZRANGE', category: 'Sorted Set', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'start', label: 'Start', required: false, default: '0' },
      { name: 'stop', label: 'Stop', required: false, default: '-1' },
    ],
  },
  {
    command: 'ZREVRANGE', label: 'ZREVRANGE', category: 'Sorted Set', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'start', label: 'Start', required: false, default: '0' },
      { name: 'stop', label: 'Stop', required: false, default: '-1' },
    ],
  },
  {
    command: 'ZRANGEBYSCORE', label: 'ZRANGEBYSCORE', category: 'Sorted Set', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'min', label: 'Min score', required: true },
      { name: 'max', label: 'Max score', required: true },
      { name: 'offset', label: 'Offset (LIMIT)', required: false },
      { name: 'count', label: 'Count (LIMIT)', required: false },
    ],
  },
  {
    command: 'ZRANGEWITHSCORES', label: 'ZRANGE WITHSCORES', category: 'Sorted Set', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'start', label: 'Start', required: false, default: '0' },
      { name: 'stop', label: 'Stop', required: false, default: '-1' },
    ],
  },
  {
    command: 'ZREVRANGEWITHSCORES', label: 'ZREVRANGE WITHSCORES', category: 'Sorted Set', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'start', label: 'Start', required: false, default: '0' },
      { name: 'stop', label: 'Stop', required: false, default: '-1' },
    ],
  },
  {
    command: 'ZCARD', label: 'ZCARD', category: 'Sorted Set', isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'ZCOUNT', label: 'ZCOUNT', category: 'Sorted Set', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'min', label: 'Min score', required: true },
      { name: 'max', label: 'Max score', required: true },
    ],
  },
  {
    command: 'ZSCORE', label: 'ZSCORE', category: 'Sorted Set', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'member', label: 'Member', required: true },
    ],
  },
  {
    command: 'ZRANK', label: 'ZRANK', category: 'Sorted Set', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'member', label: 'Member', required: true },
    ],
  },
  {
    command: 'ZREVRANK', label: 'ZREVRANK', category: 'Sorted Set', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'member', label: 'Member', required: true },
    ],
  },
  {
    command: 'ZADD', label: 'ZADD', category: 'Sorted Set', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'score', label: 'Score', required: true },
      { name: 'member', label: 'Member', required: true },
    ],
  },
  {
    command: 'ZREM', label: 'ZREM', category: 'Sorted Set', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'member', label: 'Member', required: true },
    ],
  },
  {
    command: 'ZINCRBY', label: 'ZINCRBY', category: 'Sorted Set', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'increment', label: 'Increment', required: true },
      { name: 'member', label: 'Member', required: true },
    ],
  },
  {
    command: 'ZREMRANGEBYSCORE', label: 'ZREMRANGEBYSCORE', category: 'Sorted Set', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'min', label: 'Min score', required: true },
      { name: 'max', label: 'Max score', required: true },
    ],
  },

  // ── Stream ───────────────────────────────────────────────────
  {
    command: 'XREAD', label: 'XREAD', category: 'Stream', isWrite: false,
    fields: [
      { name: 'key', label: 'Stream Key', required: true },
      { name: 'id', label: 'ID', required: false, default: '0-0' },
      { name: 'count', label: 'Count', required: false, default: '10' },
    ],
  },
  {
    command: 'XREADGROUP', label: 'XREADGROUP', category: 'Stream', isWrite: false,
    fields: [
      { name: 'group', label: 'Group', required: true },
      { name: 'consumer', label: 'Consumer', required: true },
      { name: 'key', label: 'Stream Key', required: true },
      { name: 'id', label: 'ID', required: false, default: '>' },
      { name: 'count', label: 'Count', required: false, default: '10' },
    ],
  },
  {
    command: 'XLEN', label: 'XLEN', category: 'Stream', isWrite: false,
    fields: [{ name: 'key', label: 'Stream Key', required: true }],
  },
  {
    command: 'XREVRANGE', label: 'XREVRANGE', category: 'Stream', isWrite: false,
    fields: [
      { name: 'key', label: 'Stream Key', required: true },
      { name: 'start', label: 'Start (high ID)', required: false, default: '+' },
      { name: 'end', label: 'End (low ID)', required: false, default: '-' },
      { name: 'count', label: 'Count', required: false },
    ],
  },
  {
    command: 'XINFO_GROUPS', label: 'XINFO GROUPS', category: 'Stream', isWrite: false,
    fields: [{ name: 'key', label: 'Stream Key', required: true }],
  },
  {
    command: 'XADD', label: 'XADD', category: 'Stream', isWrite: true,
    fields: [
      { name: 'key', label: 'Stream Key', required: true },
      { name: 'id', label: 'ID', required: false, default: '*' },
      { name: 'fields', label: 'Fields (JSON: {"f1":"v1","f2":"v2"})', required: true },
    ],
  },
  {
    command: 'XDEL', label: 'XDEL', category: 'Stream', isWrite: true,
    fields: [
      { name: 'key', label: 'Stream Key', required: true },
      { name: 'id', label: 'Message ID', required: true },
    ],
  },
  {
    command: 'XACK', label: 'XACK', category: 'Stream', isWrite: true,
    fields: [
      { name: 'key', label: 'Stream Key', required: true },
      { name: 'group', label: 'Group', required: true },
      { name: 'id', label: 'Message ID', required: true },
    ],
  },
  {
    command: 'XGROUP_CREATE', label: 'XGROUP CREATE', category: 'Stream', isWrite: true,
    fields: [
      { name: 'key', label: 'Stream Key', required: true },
      { name: 'group', label: 'Group Name', required: true },
      { name: 'id', label: 'Start ID', required: false, default: '$' },
    ],
  },

  // ── Geo ──────────────────────────────────────────────────────
  {
    command: 'GEOSEARCH', label: 'GEOSEARCH', category: 'Geo', isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'longitude', label: 'Longitude', required: true },
      { name: 'latitude', label: 'Latitude', required: true },
      { name: 'radius', label: 'Radius', required: true },
      { name: 'unit', label: 'Unit', required: false, default: 'km' },
    ],
  },
  {
    command: 'GEOADD', label: 'GEOADD', category: 'Geo', isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'longitude', label: 'Longitude', required: true },
      { name: 'latitude', label: 'Latitude', required: true },
      { name: 'member', label: 'Member', required: true },
    ],
  },

  // ── Utility ──────────────────────────────────────────────────
  {
    command: 'PING', label: 'PING', category: 'Utility', isWrite: false,
    fields: [],
  },
  {
    command: 'PUBLISH', label: 'PUBLISH', category: 'Utility', isWrite: true,
    fields: [
      { name: 'channel', label: 'Channel', required: true },
      { name: 'message', label: 'Message', required: true },
    ],
  },
];

export const RAW_COMMAND: RedisCommandDefinition = {
  command: 'RAW',
  label: 'RAW (any command)',
  category: 'Master Only',
  isWrite: true,
  fields: [
    { name: 'rawCommand', label: 'Full Redis command (e.g., GET mykey)', required: true },
  ],
};

// Derived arrays
export const READ_COMMANDS = ALL_STRUCTURED_COMMANDS.filter((c) => !c.isWrite);
export const WRITE_COMMANDS = ALL_STRUCTURED_COMMANDS.filter((c) => c.isWrite);
export const ALL_COMMANDS = [...ALL_STRUCTURED_COMMANDS];

export function getCommandDefinition(command: string): RedisCommandDefinition | undefined {
  if (command === 'RAW') return RAW_COMMAND;
  return ALL_STRUCTURED_COMMANDS.find((c) => c.command === command);
}
