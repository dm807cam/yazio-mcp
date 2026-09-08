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
import { AuthStore } from './store.js';
import { verifyPassword } from './password.js';
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
  expiresAt: number;
}

export interface ProviderOptions {
  store: AuthStore;
  /** Canonical resource URI of this MCP server, e.g. https://host/mcp */
  resourceUri: string;
  /** OAuth issuer identifier, e.g. https://host */
  issuer: string;
  /** scrypt hash produced by hashPassword(). */
  passwordHash: string;
}

/**
 * Single-user OAuth 2.1 authorization server.
 *
 * The protocol surface (/authorize, /token, /register, /revoke, metadata) is
 * provided by the SDK's mcpAuthRouter; this class supplies the decisions:
 * who may log in, what codes and tokens mean, and how they are validated.
 *
 * Authorization codes and pending logins are deliberately in-memory only —
 * both are short-lived, and losing them across a restart costs the user one
 * retry rather than a broken connector.
 */
export class SingleUserOAuthProvider implements OAuthServerProvider {
  private readonly store: AuthStore;
  private readonly resourceUri: string;
  private readonly issuer: string;
  private readonly passwordHash: string;

  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly codes = new Map<string, CodeRecord>();

  constructor(options: ProviderOptions) {
    this.store = options.store;
    this.resourceUri = options.resourceUri;
    this.issuer = options.issuer;
    this.passwordHash = options.passwordHash;
  }

  get clientsStore(): AuthStore {
    return this.store;
  }

  /** Render the consent/login screen. The redirect happens later, in completeLogin. */
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
   * Handle the login form submission. Returns the URL to redirect the browser to,
   * or an error to re-render the form with.
   */
  completeLogin(pendingId: string, password: string): { redirectTo: string } | { error: string } {
    this.sweep();

    const pending = this.pendingLogins.get(pendingId);
    if (!pending) {
      return { error: 'This login request expired. Start the connection again from your client.' };
    }

    if (!verifyPassword(password, this.passwordHash)) {
      return { error: 'Incorrect password.' };
    }

    this.pendingLogins.delete(pendingId);

    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, {
      clientId: pending.client.client_id,
      codeChallenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri,
      scopes: pending.params.scopes ?? [],
      resource: pending.params.resource?.href,
      expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS
    });

    const redirectTo = new URL(pending.params.redirectUri);
    redirectTo.searchParams.set('code', code);
    if (pending.params.state !== undefined) {
      redirectTo.searchParams.set('state', pending.params.state);
    }
    // RFC 9207: let the client confirm which AS answered.
    redirectTo.searchParams.set('iss', this.issuer);

    return { redirectTo: redirectTo.href };
  }

  /** Look up the pending login so a failed attempt can be re-rendered. */
  pendingClientName(pendingId: string): string | undefined {
    const pending = this.pendingLogins.get(pendingId);
    if (!pending) {
      return undefined;
    }
    return pending.client.client_name ?? pending.client.client_id;
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

    // Single use, regardless of what happens below.
    this.codes.delete(authorizationCode);

    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }

    // PKCE itself is verified by the SDK token handler via challengeForAuthorizationCode.
    return this.issueTokens(client.client_id, record.scopes, resource?.href ?? record.resource);
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

    const granted = scopes && scopes.length > 0 ? scopes : record.scopes;
    return this.issueTokens(client.client_id, granted, resource?.href ?? record.resource);
  }

  private issueTokens(clientId: string, scopes: string[], requestedResource?: string): OAuthTokens {
    // Always bind the token to this resource. Leaving it unset when a client
    // omits the `resource` parameter would silently skip audience validation.
    const resource = requestedResource ?? this.resourceUri;

    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;

    this.store.saveAccessToken(accessToken, { clientId, scopes, resource, expiresAt });
    this.store.saveRefreshToken(refreshToken, { clientId, scopes, resource });

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

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: new URL(this.resourceUri)
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
