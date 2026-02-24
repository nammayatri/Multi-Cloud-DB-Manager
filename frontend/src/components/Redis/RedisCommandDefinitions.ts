import type { RedisCommandDefinition } from '../../types';

export const READ_COMMANDS: RedisCommandDefinition[] = [
  {
    command: 'GET',
    label: 'GET',
    isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'MGET',
    label: 'MGET',
    isWrite: false,
    fields: [{ name: 'key', label: 'Keys (comma-separated)', required: true }],
  },
  {
    command: 'HGET',
    label: 'HGET',
    isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'field', label: 'Field', required: true },
    ],
  },
  {
    command: 'HGETALL',
    label: 'HGETALL',
    isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'HKEYS',
    label: 'HKEYS',
    isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'LRANGE',
    label: 'LRANGE',
    isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'start', label: 'Start', required: false, default: '0' },
      { name: 'stop', label: 'Stop', required: false, default: '-1' },
    ],
  },
  {
    command: 'SMEMBERS',
    label: 'SMEMBERS',
    isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'ZRANGE',
    label: 'ZRANGE',
    isWrite: false,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'start', label: 'Start', required: false, default: '0' },
      { name: 'stop', label: 'Stop', required: false, default: '-1' },
    ],
  },
  {
    command: 'TTL',
    label: 'TTL',
    isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'TYPE',
    label: 'TYPE',
    isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'EXISTS',
    label: 'EXISTS',
    isWrite: false,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'XREAD',
    label: 'XREAD',
    isWrite: false,
    fields: [
      { name: 'key', label: 'Stream Key', required: true },
      { name: 'id', label: 'ID', required: false, default: '0-0' },
      { name: 'count', label: 'Count', required: false, default: '10' },
    ],
  },
  {
    command: 'XREADGROUP',
    label: 'XREADGROUP',
    isWrite: false,
    fields: [
      { name: 'group', label: 'Group', required: true },
      { name: 'consumer', label: 'Consumer', required: true },
      { name: 'key', label: 'Stream Key', required: true },
      { name: 'id', label: 'ID', required: false, default: '>' },
      { name: 'count', label: 'Count', required: false, default: '10' },
    ],
  },
];

export const WRITE_COMMANDS: RedisCommandDefinition[] = [
  {
    command: 'SET',
    label: 'SET',
    isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'value', label: 'Value', required: true },
      { name: 'ex', label: 'Expire (sec)', required: false },
    ],
  },
  {
    command: 'DEL',
    label: 'DEL',
    isWrite: true,
    fields: [{ name: 'key', label: 'Key', required: true }],
  },
  {
    command: 'HSET',
    label: 'HSET',
    isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'field', label: 'Field', required: true },
      { name: 'value', label: 'Value', required: true },
    ],
  },
  {
    command: 'EXPIRE',
    label: 'EXPIRE',
    isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'seconds', label: 'Seconds', required: true },
    ],
  },
  {
    command: 'LPUSH',
    label: 'LPUSH',
    isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'value', label: 'Value', required: true },
    ],
  },
  {
    command: 'RPUSH',
    label: 'RPUSH',
    isWrite: true,
    fields: [
      { name: 'key', label: 'Key', required: true },
      { name: 'value', label: 'Value', required: true },
    ],
  },
];

export const RAW_COMMAND: RedisCommandDefinition = {
  command: 'RAW',
  label: 'RAW (any command)',
  isWrite: true, // treat as write for permission display purposes
  fields: [
    { name: 'rawCommand', label: 'Full Redis command (e.g., CLUSTER INFO)', required: true },
  ],
};

export const ALL_COMMANDS = [...READ_COMMANDS, ...WRITE_COMMANDS];

export function getCommandDefinition(command: string): RedisCommandDefinition | undefined {
  if (command === 'RAW') return RAW_COMMAND;
  return ALL_COMMANDS.find((c) => c.command === command);
}
