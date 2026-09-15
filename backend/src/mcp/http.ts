import express, { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AuthError, extractCredentials } from './auth';
import { ApiError, DbManagerSession } from './session';
import { createServer } from './register';

/**
 * Stateless MCP Streamable HTTP endpoint (mirrors control-center's /api/mcp).
 * Each POST carries the caller's DB Manager username + password; tools call this
 * backend's own /api/redis and /api/shudhi routes as that user.
 *
 * Mounted from server.ts at /api/mcp.
 */
export function createMcpRouter(): Router {
  const router = express.Router();
  const baseUrl = (process.env.MCP_API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/+$/, '');
  const allowWrites = process.env.MCP_ALLOW_WRITES === 'true';

  router.post('/', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const session = new DbManagerSession(baseUrl, extractCredentials(req));
      await session.ensureLoggedIn();
      const server = createServer(session, { allowWrites });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (err instanceof AuthError || err instanceof ApiError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Stateless: no GET SSE stream, no DELETE session teardown.
  router.all('/', (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed. The MCP endpoint accepts POST only.' });
  });

  return router;
}
