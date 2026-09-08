#!/usr/bin/env node

import { createApp } from './http-app.js';
import { createYazioClient } from './yazio-client.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ ${name} is required`);
    process.exit(1);
  }
  return value;
}

function main(): void {
  // No Yazio credentials here by design: users sign in through the browser
  // during the OAuth flow, so this process holds no account secret at rest.
  const publicUrl = requireEnv('PUBLIC_URL').replace(/\/$/, '');
  const statePath = process.env.STATE_PATH ?? '/var/lib/yazio-mcp/auth-state.json';
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';

  const app = createApp({
    publicUrl,
    statePath,
    authenticate: (username, password) => createYazioClient({ username, password })
  });

  const server = app.listen(port, host, () => {
    console.log(`🚀 Yazio MCP listening on http://${host}:${port}`);
    console.log(`   MCP endpoint: ${publicUrl}/mcp`);
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
