import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isWriteCommand } from '../services/redis/RedisCommandExecutor';
import { DbManagerSession } from './session';

interface Options {
  /** When false (default), Redis write commands and Shudhi cache refresh are refused before hitting the API. */
  allowWrites: boolean;
}

function text(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
  };
}

/** Same trick as control-center: loosen the overload types to avoid TS2589 on zod-inferred args. */
function register<A>(
  server: McpServer,
  name: string,
  description: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any,
  handler: (args: A) => Promise<unknown>
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cb: any = async (args: A) => {
    try {
      return text(await handler(args));
    } catch (err) {
      return errorResult(err);
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(name, { description, inputSchema: schema }, cb);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const serviceField = z
  .string()
  .optional()
  .describe("Redis service name from redis_configuration (e.g. 'main'). Defaults to 'main'.");
const cloudField = z
  .string()
  .min(1)
  .describe("Target cloud name from redis_configuration (e.g. 'aws', 'gcp'), or 'both' to run on every cloud of the service.");

export function createServer(session: DbManagerSession, opts: Options): McpServer {
  const server = new McpServer({ name: 'db-manager-mcp', version: '0.1.0' });

  // ───────────────────────────── Redis ─────────────────────────────

  register(
    server,
    'redis_configuration',
    'List the Redis services and the clouds under each (names only, no hosts). CALL THIS FIRST to learn valid `service` and `cloud` values for the other redis_* tools.',
    {},
    () => session.request('GET', '/api/redis/configuration')
  );

  register<{ command: string; args?: Record<string, string>; cloud: string; service?: string }>(
    server,
    'redis_command',
    [
      'Run ONE structured Redis command on a service/cloud and get per-cloud results.',
      'Args are named, not positional. Common shapes:',
      'GET/TTL/TYPE/EXISTS/DEL/HGETALL/HKEYS/LLEN/SMEMBERS/ZCARD/XLEN {key};',
      'MGET {key: "k1,k2"}; HGET/HDEL {key, field}; HMGET {key, fields: "f1,f2"}; HSET {key, field, value};',
      'SET {key, value, ex?}; SETEX {key, seconds, value}; EXPIRE {key, seconds};',
      'LRANGE/ZRANGE/ZRANGE_WITHSCORES {key, start?, stop?}; ZRANGEBYSCORE/ZCOUNT {key, min, max};',
      'ZSCORE/ZRANK/SISMEMBER {key, member}; XRANGE/XREVRANGE {key, start?, end?, count?}; GEORADIUS {key, longitude, latitude, radius, unit?}.',
      'KEYS, FLUSH*, EVAL, RAW etc. are blocked. Writes require the caller to have write role AND the server to run with MCP_ALLOW_WRITES=true.',
      'To find keys by pattern use redis_scan instead.',
    ].join(' '),
    {
      command: z.string().min(1).describe('Redis command name, e.g. GET, HGETALL, TTL, ZRANGE.'),
      args: z.record(z.string()).optional().default({}).describe('Named arguments for the command (see description).'),
      cloud: cloudField,
      service: serviceField,
    },
    async (a) => {
      const command = a.command.toUpperCase();
      if (command === 'RAW') throw new Error('RAW commands are not exposed over MCP.');
      if (isWriteCommand(command) && !opts.allowWrites) {
        throw new Error(`${command} is a write command; this MCP server is read-only (MCP_ALLOW_WRITES is not enabled).`);
      }
      return session.request('POST', '/api/redis/execute', {
        command,
        args: a.args ?? {},
        cloud: a.cloud,
        service: a.service,
      });
    }
  );

  register<{ pattern: string; cloud: string; service?: string; scanCount?: number; waitSeconds?: number }>(
    server,
    'redis_scan',
    "Find keys matching a glob pattern (non-blocking SCAN, preview only — never deletes). Starts the scan and waits up to `waitSeconds` for it to finish; if still running, returns the executionId so you can call redis_scan_status. Keep patterns specific (e.g. 'CachedQueries:Merchant:*'), broad patterns on prod clusters are slow.",
    {
      pattern: z.string().min(1).describe("Glob pattern, e.g. 'driver-offer:*:abc*'."),
      cloud: cloudField,
      service: serviceField,
      scanCount: z.number().int().positive().max(200000).optional().describe('Max keys to collect. Server default applies if omitted.'),
      waitSeconds: z.number().int().min(0).max(60).optional().default(20).describe('How long to wait for completion before returning the executionId. Default 20.'),
    },
    async (a) => {
      const started = await session.request<{ executionId: string }>('POST', '/api/redis/scan', {
        pattern: a.pattern,
        cloud: a.cloud,
        service: a.service,
        scanCount: a.scanCount,
        action: 'preview',
      });
      const deadline = Date.now() + (a.waitSeconds ?? 20) * 1000;
      let status: { status?: string } = { status: 'started' };
      while (Date.now() < deadline) {
        await sleep(1000);
        status = await session.request('GET', `/api/redis/scan/${encodeURIComponent(started.executionId)}`);
        if (status.status && !['running', 'started', 'pending'].includes(status.status)) break;
      }
      return { executionId: started.executionId, ...status };
    }
  );

  register<{ executionId: string }>(
    server,
    'redis_scan_status',
    'Get progress/results of a scan started by redis_scan (use when redis_scan returned while still running).',
    { executionId: z.string().min(1) },
    (a) => session.request('GET', `/api/redis/scan/${encodeURIComponent(a.executionId)}`)
  );

  register<{ limit?: number; offset?: number }>(
    server,
    'redis_history',
    'Audit trail of Redis WRITE operations (SET/DEL/HSET…, SCAN deletes) done through DB Manager: who, what, which cloud, when. USE FOR "who changed/deleted this key?".',
    {
      limit: z.number().int().min(1).max(200).optional().default(20),
      offset: z.number().int().min(0).optional().default(0),
    },
    (a) => session.request('GET', `/api/redis/history?limit=${a.limit ?? 20}&offset=${a.offset ?? 0}`)
  );

  // ───────────────────────────── Shudhi (in-memory cache inspector) ─────────────────────────────

  register(
    server,
    'shudhi_status',
    "Health of the Shudhi cache service (is it configured/reachable, its redis + app flags). Call if other shudhi_* tools fail.",
    {},
    () => session.request('GET', '/api/shudhi/status')
  );

  register(
    server,
    'shudhi_services',
    'List services registered with Shudhi (apps whose pods expose their in-memory cache). CALL FIRST to get a valid serviceName.',
    {},
    () => session.request('GET', '/api/shudhi/services')
  );

  register<{ service: string }>(
    server,
    'shudhi_pods',
    'List live pods (podName + sidecarUrl) of a Shudhi service.',
    { service: z.string().min(1).describe('Service name from shudhi_services.') },
    (a) => session.request('GET', `/api/shudhi/pods?service=${encodeURIComponent(a.service)}`)
  );

  register<{ service: string; pod?: string; contains?: string; limit?: number }>(
    server,
    'shudhi_keys',
    'List in-memory cache keys registered by a service (keyName, podName, ttlInSeconds, registeredAt). Without `pod`, each key appears once with a `pods` array of every pod holding it. Optionally filter by pod and by a substring of the key name — listings can be large, so prefer `contains`.',
    {
      service: z.string().min(1),
      pod: z.string().optional().describe('Restrict to one pod.'),
      contains: z.string().optional().describe('Case-insensitive substring filter on keyName (applied here, after fetching).'),
      limit: z.number().int().min(1).max(1000).optional().default(200),
    },
    async (a) => {
      const qs = `service=${encodeURIComponent(a.service)}${a.pod ? `&pod=${encodeURIComponent(a.pod)}` : ''}`;
      const res = await session.request<{ keys: Array<{ keyName: string }> }>('GET', `/api/shudhi/keys?${qs}`);
      const needle = a.contains?.toLowerCase();
      const matched = (res.keys ?? []).filter((k) => !needle || k.keyName.toLowerCase().includes(needle));
      const limit = a.limit ?? 200;
      return { total: res.keys?.length ?? 0, matched: matched.length, truncated: matched.length > limit, keys: matched.slice(0, limit) };
    }
  );

  register<{ serviceName: string; podName: string; key: string }>(
    server,
    'shudhi_get_value',
    "Read the CURRENT in-memory cached value of a key on ONE pod. USE FOR 'is pod X serving a stale config?' — compare across pods or against the DB/Redis value.",
    {
      serviceName: z.string().min(1),
      podName: z.string().min(1).describe('Pod name from shudhi_pods / shudhi_keys.'),
      key: z.string().min(1).describe('Exact keyName from shudhi_keys.'),
    },
    (a) => session.request('POST', '/api/shudhi/get', a)
  );

  register<{ serviceName: string; keyInfix?: string }>(
    server,
    'shudhi_refresh',
    'WRITE: invalidate in-memory cache on ALL pods of a service (optionally only keys containing keyInfix). Returns per-pod acks. Requires non-READER role AND MCP_ALLOW_WRITES=true. Confirm with the user before calling.',
    {
      serviceName: z.string().min(1),
      keyInfix: z.string().optional().describe('Only refresh keys whose name contains this. Omit to refresh everything for the service.'),
    },
    async (a) => {
      if (!opts.allowWrites) {
        throw new Error('shudhi_refresh is a write; this MCP server is read-only (MCP_ALLOW_WRITES is not enabled).');
      }
      return session.request('POST', '/api/shudhi/refresh', a);
    }
  );

  return server;
}
