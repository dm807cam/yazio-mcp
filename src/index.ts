#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { YazioMcpServer } from './server.js';
import { credentialsFromEnv } from './yazio-client.js';

async function main(): Promise<void> {
  const credentials = credentialsFromEnv();

  if (!credentials) {
    console.error('❌ YAZIO_USERNAME and YAZIO_PASSWORD environment variables are required');
    console.error('💡 Please set these environment variables with your Yazio account credentials');
    process.exit(1);
  }

  let server: YazioMcpServer;
  try {
    server = await YazioMcpServer.createFromCredentials(credentials);
    console.error('✅ Successfully authenticated with Yazio using environment variables');
  } catch (error) {
    console.error('❌ Failed to authenticate with Yazio:', (error as Error).message);
    console.error('💡 Please check your YAZIO_USERNAME and YAZIO_PASSWORD environment variables');
    process.exit(1);
  }

  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.mcpServer.connect(transport);
  console.error('Yazio MCP server running on stdio');
}

main().catch(console.error);
