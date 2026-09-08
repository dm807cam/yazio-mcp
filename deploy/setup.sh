#!/usr/bin/env bash
# Install the Yazio MCP remote connector as a hardened systemd service.
#
#   sudo bash setup.sh
#
# Non-interactive and idempotent: there are no secrets to configure, because
# users sign in to Yazio in the browser when they connect a client.
set -euo pipefail

APP_USER=yazio-mcp
APP_DIR=/opt/yazio-mcp
STAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

echo "==> Creating system user '$APP_USER'"
if ! getent passwd "$APP_USER" >/dev/null; then
  # --system: no aging, no password, low uid. No home, no shell: this account
  # exists only to own the service process.
  useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  echo "    created"
else
  echo "    already exists, leaving alone"
fi

echo "==> Installing application to $APP_DIR"
install -d -o root -g root -m 0755 "$APP_DIR"
rm -rf "${APP_DIR:?}/dist"
cp -r "$STAGE_DIR/dist" "$APP_DIR/dist"
cp "$STAGE_DIR/package.json" "$APP_DIR/package.json"
# Root-owned and read-only to the service: the app cannot rewrite its own code.
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

# Older revisions of this project kept Yazio credentials here. Nothing reads it
# now, so remove it rather than leaving a stale secret on disk.
if [[ -f /etc/yazio-mcp/env ]]; then
  echo "==> Removing obsolete /etc/yazio-mcp/env (credentials are no longer stored)"
  shred -u /etc/yazio-mcp/env 2>/dev/null || rm -f /etc/yazio-mcp/env
  rmdir /etc/yazio-mcp 2>/dev/null || true
fi

echo "==> Installing systemd unit"
cp "$STAGE_DIR/yazio-mcp.service" /etc/systemd/system/yazio-mcp.service
chmod 0644 /etc/systemd/system/yazio-mcp.service
systemctl daemon-reload
systemctl enable yazio-mcp.service >/dev/null

echo "==> Starting service"
systemctl restart yazio-mcp.service
sleep 3

if systemctl is-active --quiet yazio-mcp.service; then
  echo
  echo "✅ yazio-mcp is running on 127.0.0.1:8790"
  curl -fsS http://127.0.0.1:8790/healthz && echo
else
  echo
  echo "❌ Service failed to start. Recent log:" >&2
  journalctl -u yazio-mcp.service -n 30 --no-pager >&2
  exit 1
fi
