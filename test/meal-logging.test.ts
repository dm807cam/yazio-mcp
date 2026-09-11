#!/usr/bin/env tsx
/**
 * Logging a meal made of several foods. Each food has to reach Yazio as its own
 * diary entry: that is what lets the user see the ingredients in the app and
 * correct one of them later.
 *
 * Runs the real MCP server and the real Yazio client; only the network is
 * faked, so the assertions are about the requests Yazio would receive.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Yazio } from 'yazio';
import { YazioMcpServer } from '../src/server.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`);
    if (detail !== undefined) {
      console.log(`     ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }
  }
}

const BREAD = { product_id: '4ceff6e9-78ce-441b-964a-22e81c1dee92', amount: 45, serving: 'slice', serving_quantity: 1 };
const BUTTER = { product_id: 'b2f1c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', amount: 10, serving: 'tablespoon', serving_quantity: 1 };
const GOUDA = { product_id: 'c3d4e5f6-7a8b-4c9d-ae0f-1a2b3c4d5e6f', amount: 25, serving: 'slice', serving_quantity: 1 };
const MEAL = { date: '2026-09-11', daytime: 'breakfast', items: [BREAD, BUTTER, GOUDA] };

interface DiaryEntry {
  id: string;
  product_id: string;
  date: string;
  daytime: string;
  amount: number;
  serving: string;
  serving_quantity: number;
}

interface LogResult {
  added: { id: string; product_id: string }[];
  failed: { product_id: string }[];
}

/** State of the fake Yazio API that replaces fetch for the whole run. */
const yazioApi = {
  /** Entries Yazio accepted, i.e. what the user's diary now holds. */
  diary: [] as DiaryEntry[],
  /** Writes of this product are answered with a server error. */
  failingProductId: undefined as string | undefined
};

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const path = new URL(input instanceof Request ? input.url : input).pathname;
  if (path.endsWith('/user/consumed-items') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as { products: DiaryEntry[] };
    if (body.products.some(entry => entry.product_id === yazioApi.failingProductId)) {
      return new Response('upstream error', { status: 500, statusText: 'Internal Server Error' });
    }
    yazioApi.diary.push(...body.products);
    return new Response(null, { status: 204 });
  }
  return new Response('not found', { status: 404, statusText: 'Not Found' });
}

/** The JSON report after the tool's summary line; empty if there is none. */
function parseResult(result: Awaited<ReturnType<Client['callTool']>>): LogResult {
  const content = result.content as { type: string; text?: string }[];
  const text = content.find(block => block.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text.slice(text.indexOf('{'))) as LogResult;
  } catch {
    return { added: [], failed: [] };
  }
}

/** Every reported entry names the id that was written for that product. */
function reportsWrittenIds(reported: LogResult['added'], diary: DiaryEntry[]): boolean {
  return (
    reported.length === diary.length &&
    diary.every(entry => reported.some(item => item.product_id === entry.product_id && item.id === entry.id))
  );
}

async function main(): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch as typeof fetch;

  try {
    // A token that is still valid, so the client never tries to sign in.
    const yazio = new Yazio({
      token: {
        token_type: 'bearer',
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600,
        expires_at: Date.now() + 3600 * 1000
      }
    });
    const server = new YazioMcpServer(yazio);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(serverTransport);
    const client = new Client({ name: 'meal-logging-test', version: '0.0.0' });
    await client.connect(clientTransport);

    console.log('\n1. Bread, butter and gouda logged as one meal');
    yazioApi.diary = [];
    yazioApi.failingProductId = undefined;
    const result = await client.callTool({ name: 'add_user_consumed_items', arguments: MEAL });

    check('the call succeeds', result.isError !== true, result.content);
    check('the diary gains three entries', yazioApi.diary.length === 3, yazioApi.diary);
    for (const [name, food] of [['bread', BREAD], ['butter', BUTTER], ['gouda', GOUDA]] as const) {
      const entry = yazioApi.diary.find(item => item.product_id === food.product_id);
      check(
        `${name} is its own entry, with its own amount and serving, in breakfast on 2026-09-11`,
        entry !== undefined &&
          entry.amount === food.amount &&
          entry.serving === food.serving &&
          entry.serving_quantity === food.serving_quantity &&
          entry.date === '2026-09-11' &&
          entry.daytime === 'breakfast',
        entry
      );
    }
    check(
      'each entry has its own id',
      new Set(yazioApi.diary.map(entry => entry.id)).size === 3,
      yazioApi.diary.map(entry => entry.id)
    );
    check(
      'the ids reported back are the ids written, so an entry can be removed later',
      yazioApi.diary.length > 0 && reportsWrittenIds(parseResult(result).added, yazioApi.diary),
      result.content
    );

    console.log('\n2. Butter fails to save');
    yazioApi.diary = [];
    yazioApi.failingProductId = BUTTER.product_id;
    const partial = await client.callTool({ name: 'add_user_consumed_items', arguments: MEAL });

    check('the call is flagged as an error', partial.isError === true, partial.content);
    check(
      'bread and gouda are still logged',
      yazioApi.diary.length === 2 &&
        yazioApi.diary.some(entry => entry.product_id === BREAD.product_id) &&
        yazioApi.diary.some(entry => entry.product_id === GOUDA.product_id),
      yazioApi.diary
    );
    const report = parseResult(partial);
    check(
      'butter is reported as failed and not as added',
      report.failed.some(item => item.product_id === BUTTER.product_id) &&
        !report.added.some(item => item.product_id === BUTTER.product_id),
      report
    );
    check(
      'bread and gouda are reported with the ids written',
      yazioApi.diary.length > 0 && reportsWrittenIds(report.added, yazioApi.diary),
      report
    );

    await client.close();
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
