import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { Yazio } from 'yazio';
import { YazioMcpServer } from './server.js';
import { AuthStore } from './auth/store.js';
import { YazioOAuthProvider } from './auth/provider.js';
import { renderLoginPage } from './auth/login-page.js';

export interface AppOptions {
  /** Public origin, e.g. https://yazio-mcp.example.com — no trailing slash. */
  publicUrl: string;
  /** Where client registrations and token metadata are persisted. */
  statePath: string;
  /** Sign in to Yazio. Injected so tests can run without the real API. */
  authenticate: (username: string, password: string) => Promise<Yazio>;
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
  const provider = new YazioOAuthProvider({
    store,
    resourceUri,
    issuer,
    authenticate: options.authenticate
  });

  const app = express();
  app.disable('x-powered-by');
  // Cloudflare Tunnel terminates TLS; trust its forwarding headers.
  app.set('trust proxy', 1);

  // Concise access log. Without this a misconfigured client is undiagnosable:
  // the failure is visible only to the client, which reports it vaguely.
  // Deliberately records no bodies, query strings or header values, so
  // credentials and tokens cannot leak into the journal.
  app.use((req: Request, res: Response, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const auth = req.headers.authorization ? ' auth' : '';
      const mcpSession = req.headers['mcp-session-id'] ? ' session' : '';
      console.log(
        `${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - startedAt}ms)${auth}${mcpSession}`
      );
    });
    next();
  });

  // Throttle sign-in attempts per source address. mcpAuthRouter rate-limits its
  // own endpoints, but /login is ours, and it is where credentials are guessed.
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

  // Sign-in form submission: the redirect half of the authorization flow.
  app.post('/login', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
    if (tooManyAttempts(req.ip ?? 'unknown')) {
      res.status(429).type('text/plain').send('Too many attempts. Try again later.');
      return;
    }

    const pending = String(req.body?.pending ?? '');
    const username = String(req.body?.username ?? '');
    const password = String(req.body?.password ?? '');
    // Read before completeLogin, which consumes the pending record on success.
    const clientName = provider.pendingClientName(pending);

    const result = await provider.completeLogin(pending, username, password);

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
        username,
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

  // A bare 404 at the root reads as "server is down" to anyone pasting the
  // hostname into a connector dialog, when the real answer is that the endpoint
  // lives at /mcp. Say so.
  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Yazio MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { max-width: 32rem; padding: 2rem; }
  code { background: rgb(128 128 128 / .18); padding: .15em .4em; border-radius: 5px; }
</style>
<main>
  <h1>Yazio MCP</h1>
  <p>This is a Model Context Protocol server. It has no web interface.</p>
  <p>Add it to your client using the endpoint <code>${resourceUri}</code> &mdash;
     including the <code>/mcp</code> path.</p>
</main>`);
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

      // New transport. Each one is bound to the Yazio session behind the token
      // that opened it, so two people connecting reach their own accounts.
      const yazioSession = req.auth ? provider.sessionForToken(req.auth) : undefined;
      if (!yazioSession) {
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session expired, please sign in again' },
          id: null
        });
        return;
      }

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

      const mcp = new YazioMcpServer(yazioSession.client);
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

  // Anything that looks like an MCP call to the wrong path gets a JSON-RPC error
  // naming the right one, instead of Express's bare "Cannot POST /".
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      jsonrpc: '2.0',
      error: {
        code: -32601,
        message: `No MCP endpoint at ${req.path}. This server's MCP endpoint is ${resourceUri}`
      },
      id: null
    });
  });

  return app;
}
