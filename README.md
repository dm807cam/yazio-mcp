# Yazio MCP Server <img src="https://assets.yazio.com/frontend/images/branded-logo-dark.svg" alt="Yazio Logo" width="104" height="28" />

> [!IMPORTANT]
> This is **not an official MCP server** and Yazio does **not provide an official API**.
> This server uses an [unofficial reverse-engineered API](https://github.com/juriadams/yazio) and may stop working at any time.

An MCP (Model Context Protocol) server that connects Claude/Cursor to your Yazio nutrition data. Track your diet, search food products, and manage your nutrition goals directly from your AI assistant.

**Available on NPM**: `npx yazio-mcp`

**Claude Desktop Extension**: ~~[yazio-mcp.mcpb](https://github.com/fliptheweb/yazio-mcp/releases/latest/download/yazio-mcp.mcpb)~~ — one-click install is [broken upstream](https://github.com/modelcontextprotocol/mcpb/issues/281), see [workaround](#claude-desktop-extension).

## ✨ Features

- 🔐 **Authentication** - Connect with your Yazio account
- 📊 **Nutrition Analysis** - Get comprehensive diet data and insights
- 🍎 **Food Tracking** - Search, add, and manage food entries
- 🏃‍♂️ **Fitness Data** - Track exercises and water intake
- ⚖️ **Weight Monitoring** - View weight history and trends
- 🎯 **Goal Management** - Access and manage nutrition goals
- 🔍 **Product Search** - Search Yazio's extensive [food database](https://www.yazio.com/en/foods)

## 🚀 Quick Start

Add the following JSON your MCP client configuration:

```json
{
  "mcpServers": {
    "yazio": {
      "command": "npx",
      "args": ["-y", "yazio-mcp"],
      "env": {
        "YAZIO_USERNAME": "your_email@emai.com",
        "YAZIO_PASSWORD": "your_password"
      }
    }
  }
}
```


### Claude Desktop (Extension)

> [!WARNING]
> One-click `.mcpb` install is broken by a Claude Desktop bug ([mcpb#281](https://github.com/modelcontextprotocol/mcpb/issues/281)). **Workaround:** download [yazio-mcp.zip](https://github.com/fliptheweb/yazio-mcp/releases/latest/download/yazio-mcp.zip), extract it, and use **Settings → Extensions → Advanced settings → Install Unpacked Extension**. Or just use the `npx` config above.

### Claude Desktop (Manual)

`~/Library/Application Support/Claude/claude_desktop_config.json`

### Claude Code (CLI)

```bash
claude mcp add yazio -e YAZIO_USERNAME=your_email@email.com -e YAZIO_PASSWORD=your_password -- npx -y yazio-mcp
```

Verify with `claude mcp list`.

### Cursor

There are a few ways to add the server:

- **Settings UI** (easiest) — `Settings → MCP → + Add new MCP server`, then fill in the command, args, and env
- **Project config** — add JSON to `.cursor/mcp.json` in your project root
- **Global config** — add JSON to `~/.cursor/mcp.json` (applies to all projects)


## 🏠 Self-hosting as a remote connector

Besides stdio, this fork can run as a **remote MCP server** over Streamable HTTP with
OAuth 2.1, so it can be added as a custom connector in a cloud client such as Claude.ai.

```bash
npm run build
PUBLIC_URL=https://yazio-mcp.example.com \
YAZIO_USERNAME=you@example.com \
YAZIO_PASSWORD=... \
MCP_PASSWORD_HASH="$(printf 'your-connector-password' | node dist/hash-password.js)" \
STATE_PATH=./auth-state.json \
node dist/http.js
```

The MCP endpoint is then `PUBLIC_URL/mcp`.

### Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `YAZIO_USERNAME` / `YAZIO_PASSWORD` | yes | — | Yazio account this server acts as |
| `PUBLIC_URL` | yes | — | Public origin, e.g. `https://yazio-mcp.example.com`. Becomes the OAuth issuer and the canonical resource URI |
| `MCP_PASSWORD_HASH` | yes | — | scrypt hash of the connector password, from `dist/hash-password.js` |
| `STATE_PATH` | no | `/var/lib/yazio-mcp/auth-state.json` | Where client registrations and tokens persist |
| `HOST` / `PORT` | no | `127.0.0.1` / `8787` | Listen address |

### Authorization

The server is both OAuth resource server and authorization server on one hostname:

- OAuth 2.1 with PKCE (S256) and dynamic client registration (RFC 7591)
- Discovery via `/.well-known/oauth-protected-resource/mcp` (RFC 9728) and
  `/.well-known/oauth-authorization-server` (RFC 8414)
- Access tokens are audience-bound to `PUBLIC_URL/mcp` (RFC 8707); refresh tokens rotate
- A single connector password guards the consent screen, verified against a scrypt hash

`STATE_PATH` must be on persistent storage. Client registrations and refresh tokens live
there, and losing them makes an already-saved connector fail to reconnect.

> [!WARNING]
> `PUBLIC_URL` must be HTTPS, terminated by something in front of this process
> (Cloudflare Tunnel, Caddy, nginx). The server speaks plain HTTP and should bind to
> loopback only. Anyone with the connector password gets read **and write** access to
> your food diary, so choose a long one.

### Deploying on a Raspberry Pi

`deploy/` contains a hardened systemd unit and two setup scripts:

```bash
rsync -a dist package.json deploy/ pi:~/yazio-mcp-stage/
ssh -t pi 'sudo bash ~/yazio-mcp-stage/setup.sh'
ssh -t pi 'sudo bash ~/yazio-mcp-stage/setup-tunnel.sh <cloudflare-connector-token>'
```

`setup.sh` creates a dedicated `yazio-mcp` system account (no home, no shell), installs
the bundle root-owned to `/opt/yazio-mcp`, prompts for the secrets and writes them to
`/etc/yazio-mcp/env` (mode 0640), and enables the service bound to `127.0.0.1:8787`.
`setup-tunnel.sh` installs `cloudflared` and registers a tunnel connector.

## 💡 Use Cases

![Showcase](https://github.com/user-attachments/assets/3aa47086-d40e-408c-ba51-cbe8cf165404)

### 📈 Analyze Your Nutrition Trends
> *"Get my nutrition data for the last week and analyze my eating patterns"*

Claude can retrieve your daily summaries, identify trends, and provide insights about your eating habits, macro distribution, and areas for improvement.

### 🔍 Search Food Products
> *"Search for 'chicken breast' in the Yazio database"*

Find detailed nutritional information for any food product, including calories, macros, vitamins, and minerals.

### 📝 Add Forgotten Meals
> *"Add 200g of grilled salmon for yesterday's dinner"*

Easily log meals you forgot to track in the Yazio app directly from Claude or Cursor.

## 🛠️ Available Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_user_daily_summary` | Get daily nutrition summary | `date` |
| `get_user_consumed_items` | Get food entries for a date | `date` |
| `get_user_weight` | Get weight data | - |
| `get_user_exercises` | Get exercise data | `date` |
| `get_user_water_intake` | Get water intake | `date` |
| `get_user_goals` | Get nutrition goals | - |
| `get_user_settings` | Get user preferences | - |
| `search_products` | Search food database | `query` |
| `get_product` | Get detailed product info | `id` |
| `add_user_consumed_item` | Add food to your log | `productId`, `amount`, `date`, `mealType` |
| `add_user_water_intake` | Add water intake entry (cumulative value in ml) | `date`, `water_intake` |
| `remove_user_consumed_item` | Remove food from log | `itemId` |

## Test Connection

```bash
YAZIO_USERNAME='your_email' YAZIO_PASSWORD='your_password' npx yazio-mcp
```

## ⚠️ Important Disclaimers

- **Unofficial API**: This uses a [reverse-engineered API](https://github.com/juriadams/yazio) that may break
- **Credentials**: Your Yazio credentials are only used for auth on Yazio servers
- **Use at Your Own Risk**: API changes could affect functionality

## 📋 Requirements

- Node.js 18+ (for npx)
- Valid Yazio account
- MCP-compatible client (Claude Desktop, Cursor, etc.)

# Development
1. Download the repository
2. Point to local copy in your mcp config
3. Debugging:

```
YAZIO_USERNAME=X YAZIO_PASSWORD=X npx -y @modelcontextprotocol/inspector npx <local-path>/yazio-mcp
```

```bash
npm run build        # bundle the stdio and http entrypoints into dist/
npm test             # end-to-end OAuth 2.1 + MCP transport tests
npm run type-check
npm run lint
```
---

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.
