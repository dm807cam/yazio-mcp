#!/usr/bin/env bash
# Install cloudflared from Cloudflare's apt repo and register it as a service
# using a dashboard connector token.
#
#   sudo bash setup-tunnel.sh <connector-token>
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

TOKEN="${1:-}"
if [[ -z "$TOKEN" ]]; then
  echo "Usage: sudo bash setup-tunnel.sh <connector-token>" >&2
  exit 1
fi

if ! command -v cloudflared >/dev/null; then
  echo "==> Adding Cloudflare apt repository"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    -o /usr/share/keyrings/cloudflare-main.gpg
  chmod 0644 /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list

  echo "==> Installing cloudflared"
  apt-get update -qq
  apt-get install -y cloudflared
else
  echo "==> cloudflared already installed: $(cloudflared --version)"
fi

echo "==> Registering the tunnel connector service"
# Remove any previous registration so re-running this is safe.
if systemctl list-unit-files | grep -q '^cloudflared.service'; then
  cloudflared service uninstall 2>/dev/null || true
fi
cloudflared service install "$TOKEN"

sleep 4
if systemctl is-active --quiet cloudflared; then
  echo
  echo "✅ cloudflared is running"
  echo
  echo "Now, in the Cloudflare Zero Trust dashboard, give this tunnel a"
  echo "Public Hostname if you have not already:"
  echo "    hostname: yazio-mcp.mayk.eu"
  echo "    service:  HTTP  ->  localhost:8790"
else
  echo "❌ cloudflared failed to start:" >&2
  journalctl -u cloudflared -n 30 --no-pager >&2
  exit 1
fi
