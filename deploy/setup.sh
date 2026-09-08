#!/usr/bin/env bash
# Install the Yazio MCP remote connector as a hardened systemd service.
# Run as root:  sudo bash setup.sh
set -euo pipefail

APP_USER=yazio-mcp
APP_DIR=/opt/yazio-mcp
ETC_DIR=/etc/yazio-mcp
STAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_URL="https://yazio-mcp.mayk.eu"

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

echo "==> Configuring secrets in $ETC_DIR/env"
install -d -o root -g "$APP_USER" -m 0750 "$ETC_DIR"

if [[ -f "$ETC_DIR/env" ]]; then
  echo "    $ETC_DIR/env already exists — keeping it."
  echo "    Delete it and re-run this script to change credentials."
else
  echo
  echo "    Yazio account (this server logs in as you; there is no Yazio OAuth)."
  read -r -p "    Yazio email: " YAZIO_USERNAME
  read -r -s -p "    Yazio password: " YAZIO_PASSWORD; echo
  echo
  echo "    Connector password. You will type this on the sign-in page when"
  echo "    adding the connector in Claude. Only its scrypt hash is stored."
  read -r -s -p "    Connector password: " MCP_PASSWORD; echo
  read -r -s -p "    Confirm: " MCP_PASSWORD_CONFIRM; echo

  if [[ "$MCP_PASSWORD" != "$MCP_PASSWORD_CONFIRM" ]]; then
    echo "    Passwords do not match." >&2
    exit 1
  fi
  if [[ ${#MCP_PASSWORD} -lt 12 ]]; then
    echo "    Use at least 12 characters — this endpoint is on the public internet." >&2
    exit 1
  fi

  MCP_PASSWORD_HASH="$(printf '%s' "$MCP_PASSWORD" | /usr/bin/node "$APP_DIR/dist/hash-password.js")"

  umask 077
  cat > "$ETC_DIR/env" <<ENVEOF
# Yazio MCP connector configuration. Contains secrets; keep mode 0640.
PUBLIC_URL=$PUBLIC_URL
YAZIO_USERNAME=$YAZIO_USERNAME
YAZIO_PASSWORD=$YAZIO_PASSWORD
MCP_PASSWORD_HASH=$MCP_PASSWORD_HASH
ENVEOF
  unset MCP_PASSWORD MCP_PASSWORD_CONFIRM YAZIO_PASSWORD
fi

chown root:"$APP_USER" "$ETC_DIR/env"
chmod 0640 "$ETC_DIR/env"

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
  echo "✅ yazio-mcp is running on 127.0.0.1:8787"
  curl -fsS http://127.0.0.1:8787/healthz && echo
else
  echo
  echo "❌ Service failed to start. Recent log:" >&2
  journalctl -u yazio-mcp.service -n 30 --no-pager >&2
  exit 1
fi
