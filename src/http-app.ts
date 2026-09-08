import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { Yazio } from 'yazio';
import { YazioMcpServer } from './server.js';
import { AuthStore } from './auth/store.js';
import { SingleUserOAuthProvider } from './auth/provider.js';
import { renderLoginPage } from './auth/login-page.js';

export interface AppOptions {
  /** Authenticated Yazio client, shared across sessions (one account per server). */
  yazioClient: Yazio;
  /** Public origin, e.g. https://yazio-mcp.example.com — no trailing slash. */
  publicUrl: string;
  /** scrypt hash of the connector password. */
  passwordHash: string;
  /** Where client registrations and tokens are persisted. */
  statePath: string;
}

export function createApp(options: AppOptions): Express {
  const publicUrl = options.publicUrl.replace(/\/$/, '');
  const issuerUrl = new URL(publicUrl);
  // Use the URL's canonical href (which appends "/" to a bare origin) as the
  // issuer string. RFC 9207 has clients compare the `iss` authorization-response
  // parameter to the metadata issuer byte-for-byte, so the two must be built
  // from the same value or every authorization fails at the client.
  const issuer = issuerUrl.href;
  const resourceUri = `${publicUrl}/mcp`;

  const store = new AuthStore(options.statePath);
  const provider = new SingleUserOAuthProvider({
    store,
    resourceUri,
    issuer,
    passwordHash: options.passwordHash
  });

  const app = express();
  app.disable('x-powered-by');
  // Cloudflare Tunnel terminates TLS; trust its forwarding headers.
  app.set('trust proxy', 1);

  // Throttle password attempts per source address. mcpAuthRouter rate-limits its
  // own endpoints, but /login is ours, and it is the one place on this server
  // where a secret can be guessed.
  const attempts = new Map<string, { count: number; resetAt: number }>();
  const MAX_ATTEMPTS = 10;
  const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

  const tooManyAttempts = (ip: string): boolean => {
    const now = Date.now();
    const record = attempts.get(ip);

    if (!record || record.resetAt < now) {
      attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
      return false;
    }

    record.count += 1;
    return record.count > MAX_ATTEMPTS;
  };

  // Login form submission: the redirect half of the authorization flow.
  app.post('/login', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    if (tooManyAttempts(req.ip ?? 'unknown')) {
      res.status(429).type('text/plain').send('Too many attempts. Try again later.');
      return;
    }

    const pending = String(req.body?.pending ?? '');
    const password = String(req.body?.password ?? '');
    const clientName = provider.pendingClientName(pending);

    const result = provider.completeLogin(pending, password);

    if ('redirectTo' in result) {
      res.redirect(302, result.redirectTo);
      return;
    }

    res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(
      renderLoginPage({
        action: '/login',
        hidden: clientName ? { pending } : {},
        clientName: clientName ?? 'Unknown client',
        error: result.error
      })
    );
  });

  // OAuth endpoints plus both .well-known metadata documents.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl: new URL(resourceUri),
      resourceName: 'Yazio MCP',
      scopesSupported: ['yazio']
    })
  );

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  const bearerAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${publicUrl}/.well-known/oauth-protected-resource/mcp`
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.all('/mcp', bearerAuth, express.json({ limit: '4mb' }), async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId) {
        const existing = transports.get(sessionId);
        if (!existing) {
          // Unknown session (typically ours restarted). Say so and stop: building
          // a transport here would strand an McpServer that no request can reach.
          res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null
          });
          return;
        }
        await existing.handleRequest(req, res, req.body);
        return;
      }

      // New session: one McpServer per session, sharing the single Yazio client.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports.set(id, transport);
        },
        onsessionclosed: (id: string) => {
          transports.delete(id);
        }
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      const mcp = new YazioMcpServer(options.yazioClient);
      await mcp.mcpServer.connect(transport);

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  });

  return app;
}
