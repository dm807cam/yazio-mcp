# Yazio MCP as a self-hosted remote connector

Date: 2026-09-08
Status: approved

## Goal

Run this fork on a Raspberry Pi (`serverpi`, Debian 13 aarch64, Node 20) and add it to
Claude.ai as a custom connector at `https://yazio-mcp.mayk.eu`.

Upstream is stdio-only and single-user: credentials come from `YAZIO_USERNAME` /
`YAZIO_PASSWORD` and the process exits if they are missing. A cloud connector needs
Streamable HTTP on a public HTTPS URL, with OAuth 2.1 authorization.

## Non-goals

- Multi-tenant Yazio accounts. One Pi serves one Yazio user.
- Replacing upstream's stdio mode. `npx yazio-mcp` must keep working unchanged.

## Architecture

Split `src/index.ts` (~900 lines, stdio hardwired) along its natural seam:

| File | Purpose |
|---|---|
| `src/yazio-client.ts` | Builds + authenticates the Yazio client, incl. the water-intake monkey-patch |
| `src/server.ts` | `YazioMcpServer` class — tool/prompt registration, transport-agnostic |
| `src/index.ts` | stdio entrypoint (behaviour unchanged) |
| `src/http.ts` | Express + Streamable HTTP entrypoint |
| `src/auth/*` | OAuth server provider, login page, persisted store |

The 15 tools and 3 prompts move as a block without semantic change, keeping the fork
mergeable with upstream.

`YazioMcpServer` takes an already-authenticated client and never calls `process.exit`;
process-lifecycle decisions belong to the entrypoints.

## Authorization

The Pi is both resource server and authorization server on one hostname.
`mcpAuthRouter` from `@modelcontextprotocol/sdk@1.25.0` supplies `/authorize`,
`/token`, `/register` (dynamic client registration), `/revoke`, and both `.well-known`
metadata documents. We implement only the `OAuthServerProvider` interface.

- **Login**: single user. Minimal HTML form at `/authorize`. Password verified against a
  scrypt hash held in the env file; plaintext is never stored. Timing-safe compare via
  node `crypto`, so no new dependency.
- **Tokens**: opaque 32-byte random values, audience-bound to the canonical resource URI
  per RFC 8707. Access tokens live 1 hour; refresh tokens rotate on use.
- **PKCE**: S256 required. `iss` included in authorization responses (RFC 9207).
- **Persistence**: registered clients and refresh tokens are written atomically to JSON
  under the systemd `StateDirectory`. This is load-bearing — without it a service restart
  silently breaks the saved Claude.ai connector.

Known limitation: this is a hand-rolled AS for one user. It is spec-conformant and
adequate behind Cloudflare, but delegating identity to Cloudflare Access later would
mean rewriting only the provider.

## Deployment

- System user `yazio-mcp`: `--system`, no login shell, no own home; state via
  systemd `StateDirectory=yazio-mcp`.
- Code at `/opt/yazio-mcp`, root-owned and read-only to the service. The esbuild bundle is
  built on the developer machine and rsynced; output is platform-neutral JS, so no build
  toolchain is installed on the Pi.
- Secrets in `/etc/yazio-mcp/env`, mode 0600: Yazio credentials and the scrypt password
  hash. Written on the Pi by the operator, never transmitted through a chat transcript.
- `yazio-mcp.service` binds **127.0.0.1:8787 only**, never the LAN or 0.0.0.0. Hardened
  with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`.
- `cloudflared` installed from Cloudflare's apt repo as a separate service, using a
  dashboard connector token, routing `yazio-mcp.mayk.eu` to `127.0.0.1:8787`. No router
  ports are opened.

## Verification

1. Both `.well-known` documents fetch over the public hostname and carry the right issuer.
2. Unauthenticated `POST /mcp` returns 401 with `WWW-Authenticate: Bearer resource_metadata=...`.
3. A full PKCE authorization-code flow driven by curl yields a usable access token.
4. `tools/list` and `get_user` through that token return the real Yazio profile.
5. After `systemctl restart`, the same token still works — the persistence check.
