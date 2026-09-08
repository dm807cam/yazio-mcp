import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';

export interface TokenRecord {
  clientId: string;
  scopes: string[];
  resource?: string;
  /** Seconds since epoch. */
  expiresAt?: number;
}

interface PersistedState {
  clients: Record<string, OAuthClientInformationFull>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
}

const EMPTY: PersistedState = { clients: {}, accessTokens: {}, refreshTokens: {} };

/**
 * Client registrations and issued tokens, persisted to a JSON file.
 *
 * Persistence matters: without it every service restart invalidates the
 * connector registration held by the cloud client, which then fails with an
 * opaque auth error until it is removed and re-added by hand.
 */
export class AuthStore implements OAuthRegisteredClientsStore {
  private state: PersistedState;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  private load(): PersistedState {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PersistedState>;
      return {
        clients: parsed.clients ?? {},
        accessTokens: parsed.accessTokens ?? {},
        refreshTokens: parsed.refreshTokens ?? {}
      };
    } catch {
      // Missing or corrupt state file: start clean rather than refusing to boot.
      return { ...EMPTY };
    }
  }

  /** Write via a temp file + rename so a crash mid-write cannot truncate state. */
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  // --- OAuthRegisteredClientsStore ---

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.state.clients[clientId];
  }

  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    this.state.clients[client.client_id] = client;
    this.persist();
    return client;
  }

  // --- tokens ---

  saveAccessToken(token: string, record: TokenRecord): void {
    this.state.accessTokens[token] = record;
    this.pruneExpired();
    this.persist();
  }

  getAccessToken(token: string): TokenRecord | undefined {
    return this.state.accessTokens[token];
  }

  saveRefreshToken(token: string, record: TokenRecord): void {
    this.state.refreshTokens[token] = record;
    this.persist();
  }

  getRefreshToken(token: string): TokenRecord | undefined {
    return this.state.refreshTokens[token];
  }

  deleteRefreshToken(token: string): void {
    delete this.state.refreshTokens[token];
    this.persist();
  }

  deleteAccessToken(token: string): void {
    delete this.state.accessTokens[token];
    this.persist();
  }

  private pruneExpired(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [token, record] of Object.entries(this.state.accessTokens)) {
      if (record.expiresAt !== undefined && record.expiresAt < now) {
        delete this.state.accessTokens[token];
      }
    }
  }
}
