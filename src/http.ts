#!/usr/bin/env node

import { createApp } from './http-app.js';
import { credentialsFromEnv, createYazioClient } from './yazio-client.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ ${name} is required`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const credentials = credentialsFromEnv();
  if (!credentials) {
    console.error('❌ YAZIO_USERNAME and YAZIO_PASSWORD environment variables are required');
    process.exit(1);
  }

  const publicUrl = requireEnv('PUBLIC_URL').replace(/\/$/, '');
  const passwordHash = requireEnv('MCP_PASSWORD_HASH');
  const statePath = process.env.STATE_PATH ?? '/var/lib/yazio-mcp/auth-state.json';
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';

  const yazioClient = await createYazioClient(credentials);
  console.log('✅ Authenticated with Yazio');

  const app = createApp({ yazioClient, publicUrl, passwordHash, statePath });

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

main().catch(error => {
  console.error('❌ Failed to start:', error);
  process.exit(1);
});
