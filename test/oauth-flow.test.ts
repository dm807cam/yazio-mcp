#!/usr/bin/env tsx
/**
 * End-to-end test of the OAuth 2.1 + Streamable HTTP surface.
 *
 * Drives the real flow a cloud client performs: discovery, dynamic client
 * registration, PKCE authorization, token exchange, an authenticated MCP call,
 * refresh, and revocation. The Yazio client is stubbed, so this exercises the
 * transport and authorization layers without touching the Yazio API.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Yazio } from 'yazio';
import { createApp } from '../src/http-app.js';
import { hashPassword } from '../src/auth/password.js';

const PASSWORD = 'test-password-123';

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

/** Minimal stub standing in for an authenticated Yazio client. */
function stubYazioClient(): Yazio {
  return {
    user: {
      get: async () => ({ first_name: 'Test', email: 'test@example.com' })
    },
    products: {}
  } as unknown as Yazio;
}

async function main(): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), 'yazio-mcp-test-'));
  const statePath = join(stateDir, 'auth-state.json');

  const app = createApp({
    yazioClient: stubYazioClient(),
    // Rewritten to the real port once listening; discovery URLs use this origin.
    publicUrl: 'http://127.0.0.1:0',
    passwordHash: hashPassword(PASSWORD),
    statePath
  });

  // Listen first so we know the port, then rebuild with the correct public URL.
  const probe = app.listen(0, '127.0.0.1');
  await new Promise(resolve => probe.once('listening', resolve));
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  await new Promise(resolve => probe.once('close', resolve));

  const base = `http://127.0.0.1:${port}`;
  const realApp = createApp({
    yazioClient: stubYazioClient(),
    publicUrl: base,
    passwordHash: hashPassword(PASSWORD),
    statePath
  });
  const server = realApp.listen(port, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  try {
    // --- 1. Unauthenticated request is challenged correctly ---
    console.log('\n1. Unauthenticated access');
    const unauth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    check('returns 401', unauth.status === 401, unauth.status);
    const challenge = unauth.headers.get('www-authenticate') ?? '';
    check('sends WWW-Authenticate: Bearer', challenge.startsWith('Bearer'), challenge);
    check(
      'challenge points at protected resource metadata',
      challenge.includes('resource_metadata='),
      challenge
    );

    // --- 2. Discovery documents ---
    console.log('\n2. Discovery metadata');
    const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    check('protected resource metadata is 200', prm.status === 200, prm.status);
    const prmDoc = (await prm.json()) as { resource: string; authorization_servers: string[] };
    check('advertises canonical resource', prmDoc.resource === `${base}/mcp`, prmDoc.resource);
    const issuerHref = new URL(base).href;
    check(
      'advertises this server as its authorization server',
      prmDoc.authorization_servers?.includes(issuerHref),
      prmDoc.authorization_servers
    );

    const asm = await fetch(`${base}/.well-known/oauth-authorization-server`);
    check('authorization server metadata is 200', asm.status === 200, asm.status);
    const asmDoc = (await asm.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint?: string;
      code_challenge_methods_supported?: string[];
    };
    check('issuer matches', asmDoc.issuer === issuerHref, asmDoc.issuer);
    check('supports PKCE S256', asmDoc.code_challenge_methods_supported?.includes('S256') === true, asmDoc.code_challenge_methods_supported);
    check('offers dynamic client registration', Boolean(asmDoc.registration_endpoint), asmDoc.registration_endpoint);

    // --- 3. Dynamic client registration ---
    console.log('\n3. Dynamic client registration');
    const redirectUri = 'http://127.0.0.1:9999/callback';
    const reg = await fetch(asmDoc.registration_endpoint as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test Client',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      })
    });
    check('registration returns 201', reg.status === 201, reg.status);
    const client = (await reg.json()) as { client_id: string };
    check('issues a client_id', Boolean(client.client_id));

    // --- 4. Authorization with PKCE ---
    console.log('\n4. Authorization (PKCE)');
    const verifier = randomBytes(32).toString('base64url');
    const challengeValue = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(8).toString('hex');

    const authorizeUrl = new URL(`${base}/authorize`);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('code_challenge', challengeValue);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('resource', `${base}/mcp`);

    const loginPage = await fetch(authorizeUrl);
    check('authorize renders a login page', loginPage.status === 200, loginPage.status);
    const html = await loginPage.text();
    const pendingMatch = html.match(/name="pending" value="([^"]+)"/);
    check('login page carries a pending id', Boolean(pendingMatch));
    const pending = pendingMatch?.[1] ?? '';

    // Wrong password must not authorize.
    const badLogin = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pending, password: 'wrong' }),
      redirect: 'manual'
    });
    check('wrong password is rejected with 401', badLogin.status === 401, badLogin.status);

    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pending, password: PASSWORD }),
      redirect: 'manual'
    });
    check('correct password redirects', login.status === 302, login.status);
    const location = new URL(login.headers.get('location') ?? '');
    check('redirects to the registered redirect_uri', location.origin + location.pathname === redirectUri, location.href);
    check('returns state unchanged', location.searchParams.get('state') === state);
    // Must equal the metadata issuer byte-for-byte (RFC 9207 uses simple string comparison).
    check(
      'iss matches metadata issuer exactly (RFC 9207)',
      location.searchParams.get('iss') === asmDoc.issuer,
      location.searchParams.get('iss')
    );
    const code = location.searchParams.get('code') ?? '';
    check('returns an authorization code', Boolean(code));

    // --- 5. Token exchange, including PKCE enforcement ---
    console.log('\n5. Token exchange');
    const badVerifier = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: randomBytes(32).toString('base64url'),
        resource: `${base}/mcp`
      })
    });
    check('wrong code_verifier is rejected', badVerifier.status >= 400, badVerifier.status);

    // The code above was consumed by the failed attempt, so run a fresh authorization.
    const secondPage = await fetch(authorizeUrl);
    const secondPending = (await secondPage.text()).match(/name="pending" value="([^"]+)"/)?.[1] ?? '';
    const secondLogin = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pending: secondPending, password: PASSWORD }),
      redirect: 'manual'
    });
    const freshCode = new URL(secondLogin.headers.get('location') ?? '').searchParams.get('code') ?? '';

    const tokenRes = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: freshCode,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: `${base}/mcp`
      })
    });
    check('token endpoint returns 200', tokenRes.status === 200, await tokenRes.clone().text());
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
    };
    check('issues a bearer access token', tokens.token_type === 'Bearer' && Boolean(tokens.access_token));
    check('issues a refresh token', Boolean(tokens.refresh_token));

    // Authorization codes must be single-use.
    const replay = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: freshCode,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: `${base}/mcp`
      })
    });
    check('replayed authorization code is rejected', replay.status >= 400, replay.status);

    // --- 6. Authenticated MCP traffic ---
    console.log('\n6. Authenticated MCP session');
    const initRes = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${tokens.access_token}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' }
        }
      })
    });
    check('initialize succeeds', initRes.status === 200, initRes.status);
    const sessionId = initRes.headers.get('mcp-session-id') ?? '';
    check('assigns a session id', Boolean(sessionId));
    await initRes.text();

    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${tokens.access_token}`,
        'mcp-session-id': sessionId
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    });

    const listRes = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${tokens.access_token}`,
        'mcp-session-id': sessionId
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    check('tools/list succeeds', listRes.status === 200, listRes.status);
    const listBody = await listRes.text();
    const payload = listBody.includes('data: ')
      ? JSON.parse(listBody.split('data: ')[1].split('\n')[0])
      : JSON.parse(listBody);
    const toolNames: string[] = payload.result?.tools?.map((t: { name: string }) => t.name) ?? [];
    check('exposes all 15 tools', toolNames.length === 15, toolNames.length);
    check('includes get_user', toolNames.includes('get_user'), toolNames);
    check('includes add_user_consumed_item', toolNames.includes('add_user_consumed_item'));

    // A garbage token must not work.
    const badToken = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-real-token'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    });
    check('invalid token is rejected with 401', badToken.status === 401, badToken.status);

    // --- 6b. Hardening regressions ---
    console.log('\n6b. Hardening');

    // An unknown session id must be refused outright, not quietly given a fresh
    // transport that no subsequent request can reach.
    const unknownSession = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${tokens.access_token}`,
        'mcp-session-id': '00000000-0000-4000-8000-000000000000'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
    });
    check('unknown session id returns 404', unknownSession.status === 404, unknownSession.status);

    // Tokens must carry an audience even when the client omits `resource`,
    // otherwise the RFC 8707 check in verifyAccessToken is skipped.
    const thirdPage = await fetch(
      `${base}/authorize?${new URLSearchParams({
        client_id: client.client_id,
        response_type: 'code',
        redirect_uri: redirectUri,
        code_challenge: challengeValue,
        code_challenge_method: 'S256'
      })}`
    );
    const thirdPending = (await thirdPage.text()).match(/name="pending" value="([^"]+)"/)?.[1] ?? '';
    const thirdLogin = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pending: thirdPending, password: PASSWORD }),
      redirect: 'manual'
    });
    const codeNoResource = new URL(thirdLogin.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const tokenNoResource = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: codeNoResource,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier
      })
    });
    check('token issued without a resource parameter', tokenNoResource.status === 200, tokenNoResource.status);
    const unboundToken = (await tokenNoResource.json()) as { access_token: string };
    const stateOnDisk = JSON.parse(readFileSync(statePath, 'utf8')) as {
      accessTokens: Record<string, { resource?: string }>;
    };
    check(
      'that token is still audience-bound to this resource',
      stateOnDisk.accessTokens[unboundToken.access_token]?.resource === `${base}/mcp`,
      stateOnDisk.accessTokens[unboundToken.access_token]?.resource
    );

    // Brute-force protection on the one guessable secret this server exposes.
    let sawThrottle = false;
    for (let i = 0; i < 14; i++) {
      const attempt = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ pending: 'nope', password: 'guess' }),
        redirect: 'manual'
      });
      if (attempt.status === 429) {
        sawThrottle = true;
        break;
      }
    }
    check('repeated login attempts are rate limited', sawThrottle);

    // --- 7. Refresh and revocation ---
    console.log('\n7. Refresh and revocation');
    const refreshed = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
        resource: `${base}/mcp`
      })
    });
    check('refresh returns 200', refreshed.status === 200, await refreshed.clone().text());
    const newTokens = (await refreshed.json()) as { access_token: string; refresh_token: string };
    check('issues a new access token', newTokens.access_token !== tokens.access_token);

    const reused = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
        resource: `${base}/mcp`
      })
    });
    check('old refresh token is rotated out', reused.status >= 400, reused.status);

    // --- 8. Persistence across restart ---
    console.log('\n8. Persistence across restart');
    const restarted = createApp({
      yazioClient: stubYazioClient(),
      publicUrl: base,
      passwordHash: hashPassword(PASSWORD),
      statePath
    });
    server.closeAllConnections();
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
    // Fresh port: reusing `port` lets undici's pool hand us a socket to the
    // now-dead server, which fails as ECONNRESET instead of testing anything.
    const server2 = restarted.listen(0, '127.0.0.1');
    await new Promise(resolve => server2.once('listening', resolve));
    const base2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;

    try {
      const afterRestart = await fetch(`${base2}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${newTokens.access_token}`
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        })
      });
      check('access token still valid after restart', afterRestart.status === 200, afterRestart.status);
      await afterRestart.text();

      const clientAfter = await fetch(`${base2}/authorize?${new URLSearchParams({
        client_id: client.client_id,
        response_type: 'code',
        redirect_uri: redirectUri,
        code_challenge: challengeValue,
        code_challenge_method: 'S256',
        resource: `${base}/mcp`
      })}`);
      check('client registration survived restart', clientAfter.status === 200, clientAfter.status);
    } finally {
      await new Promise<void>(resolve => {
        server2.close(() => resolve());
      });
    }
  } finally {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
