import { randomUUID, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Yazio } from 'yazio';
import { AuthStore } from './store.js';
import { renderLoginPage } from './login-page.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

interface PendingLogin {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}

interface CodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  sessionId: string;
  expiresAt: number;
}

export interface YazioSession {
  client: Yazio;
  username: string;
}

export interface ProviderOptions {
  store: AuthStore;
  /** Canonical resource URI of this MCP server, e.g. https://host/mcp */
  resourceUri: string;
  /** OAuth issuer identifier, exactly as published in metadata. */
  issuer: string;
  /** Sign in to Yazio. Rejects if the credentials are refused. */
  authenticate: (username: string, password: string) => Promise<Yazio>;
}

/**
 * OAuth 2.1 authorization server whose identity provider is Yazio itself.
 *
 * The user signs in with their Yazio credentials on the consent screen; those
 * credentials are exchanged for a Yazio session held in memory and are never
 * persisted. An access token is a handle to that session, so the server holds
 * no long-lived Yazio secret at rest.
 *
 * Consequence: sessions do not survive a restart. Issued tokens then fail
 * verification with invalid_token, which is the signal for the client to run
 * the authorization flow again.
 */
export class YazioOAuthProvider implements OAuthServerProvider {
  private readonly store: AuthStore;
  private readonly resourceUri: string;
  private readonly issuer: string;
  private readonly authenticate: (username: string, password: string) => Promise<Yazio>;

  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly codes = new Map<string, CodeRecord>();
  /** Live Yazio sessions, keyed by an opaque id referenced from token records. */
  private readonly sessions = new Map<string, YazioSession>();

  constructor(options: ProviderOptions) {
    this.store = options.store;
    this.resourceUri = options.resourceUri;
    this.issuer = options.issuer;
    this.authenticate = options.authenticate;
  }

  get clientsStore(): AuthStore {
    return this.store;
  }

  /** Render the sign-in screen. The redirect happens later, in completeLogin. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep();

    const pendingId = randomUUID();
    this.pendingLogins.set(pendingId, {
      client,
      params,
      expiresAt: Date.now() + PENDING_LOGIN_TTL_MS
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(
      renderLoginPage({
        action: '/login',
        hidden: { pending: pendingId },
        clientName: client.client_name ?? client.client_id
      })
    );
  }

  /**
   * Verify Yazio credentials and, on success, mint an authorization code.
   * Returns the URL to redirect the browser to, or an error to re-render with.
   */
  async completeLogin(
    pendingId: string,
    username: string,
    password: string
  ): Promise<{ redirectTo: string } | { error: string }> {
    this.sweep();

    const pending = this.pendingLogins.get(pendingId);
    if (!pending) {
      return { error: 'This sign-in request expired. Start the connection again from your client.' };
    }

    if (!username || !password) {
      return { error: 'Enter your Yazio email and password.' };
    }

    let yazioClient: Yazio;
    try {
      yazioClient = await this.authenticate(username, password);
    } catch {
      // Deliberately vague: do not reveal whether the account exists.
      return { error: 'Yazio rejected those credentials.' };
    }

    this.pendingLogins.delete(pendingId);

    const sessionId = randomUUID();
    this.sessions.set(sessionId, { client: yazioClient, username });

    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, {
      clientId: pending.client.client_id,
      codeChallenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri,
      scopes: pending.params.scopes ?? [],
      resource: pending.params.resource?.href,
      sessionId,
      expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS
    });

    const redirectTo = new URL(pending.params.redirectUri);
    redirectTo.searchParams.set('code', code);
    if (pending.params.state !== undefined) {
      redirectTo.searchParams.set('state', pending.params.state);
    }
    // RFC 9207: let the client confirm which authorization server answered.
    redirectTo.searchParams.set('iss', this.issuer);

    return { redirectTo: redirectTo.href };
  }

  /** Look up a pending login so a failed attempt can be re-rendered in context. */
  pendingClientName(pendingId: string): string | undefined {
    const pending = this.pendingLogins.get(pendingId);
    if (!pending) {
      return undefined;
    }
    return pending.client.client_name ?? pending.client.client_id;
  }

  /** The Yazio session behind a verified access token, if it is still live. */
  sessionForToken(auth: AuthInfo): YazioSession | undefined {
    const sessionId = auth.extra?.sessionId;
    if (typeof sessionId !== 'string') {
      return undefined;
    }
    return this.sessions.get(sessionId);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }

    // Single use, whatever happens below.
    this.codes.delete(authorizationCode);

    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }

    // PKCE is verified by the SDK token handler via challengeForAuthorizationCode.
    return this.issueTokens(
      client.client_id,
      record.scopes,
      record.sessionId,
      resource?.href ?? record.resource
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = this.store.getRefreshToken(refreshToken);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid refresh token');
    }

    // Rotate: a refresh token is never valid twice.
    this.store.deleteRefreshToken(refreshToken);

    if (!record.sessionId || !this.sessions.has(record.sessionId)) {
      // The Yazio session is gone (restart, or revoked). Force a fresh sign-in.
      throw new InvalidGrantError('Session expired, please sign in again');
    }

    const granted = scopes && scopes.length > 0 ? scopes : record.scopes;
    return this.issueTokens(client.client_id, granted, record.sessionId, resource?.href ?? record.resource);
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    sessionId: string,
    requestedResource?: string
  ): OAuthTokens {
    // Always bind the token to this resource. Leaving it unset when a client
    // omits the `resource` parameter would silently skip audience validation.
    const resource = requestedResource ?? this.resourceUri;

    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;

    this.store.saveAccessToken(accessToken, { clientId, scopes, resource, sessionId, expiresAt });
    this.store.saveRefreshToken(refreshToken, { clientId, scopes, resource, sessionId });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: scopes.join(' '),
      refresh_token: refreshToken
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.getAccessToken(token);
    if (!record) {
      throw new InvalidTokenError('Invalid access token');
    }

    if (record.expiresAt !== undefined && record.expiresAt < Math.floor(Date.now() / 1000)) {
      this.store.deleteAccessToken(token);
      throw new InvalidTokenError('Access token has expired');
    }

    // RFC 8707 audience binding: refuse a token minted for a different resource.
    if (record.resource !== undefined && !this.matchesResource(record.resource)) {
      throw new InvalidTokenError('Access token was not issued for this resource');
    }

    if (!record.sessionId || !this.sessions.has(record.sessionId)) {
      // Tokens outlive Yazio sessions across a restart. Reporting invalid_token
      // is what prompts the client to run the authorization flow again.
      throw new InvalidTokenError('Session expired, please sign in again');
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: new URL(this.resourceUri),
      extra: { sessionId: record.sessionId }
    };
  }

  /** Compare ignoring a trailing slash, which clients treat as insignificant here. */
  private matchesResource(candidate: string): boolean {
    const normalize = (value: string): string => value.replace(/\/$/, '').toLowerCase();
    return normalize(candidate) === normalize(this.resourceUri);
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const { token } = request;

    const access = this.store.getAccessToken(token);
    if (access && access.clientId === client.client_id) {
      this.store.deleteAccessToken(token);
    }

    const refresh = this.store.getRefreshToken(token);
    if (refresh && refresh.clientId === client.client_id) {
      this.store.deleteRefreshToken(token);
    }
  }

  /** Drop expired pending logins and codes so the maps cannot grow without bound. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, pending] of this.pendingLogins) {
      if (pending.expiresAt < now) {
        this.pendingLogins.delete(id);
      }
    }
    for (const [code, record] of this.codes) {
      if (record.expiresAt < now) {
        this.codes.delete(code);
      }
    }
  }
}
