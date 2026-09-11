#!/usr/bin/env bash
# Keep the Yazio MCP connector on the newest commit of its repository.
#
#   sudo bash setup-autoupdate.sh
#
# Installs yazio-mcp-update.timer, which every 5 minutes runs
# yazio-mcp-update.sh: fetch the branch, build and test it as the unprivileged
# yazio-mcp-build user, and install and restart only if the app changed,
# rolling back if it does not come up. Needs the service from setup.sh.
# Idempotent: re-run it to apply changes to the updater itself.
set -euo pipefail

BUILD_USER=yazio-mcp-build
STATE_DIR=/var/lib/yazio-mcp-updater
LIB_DIR=/usr/local/lib/yazio-mcp
STAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

if [[ ! -f /etc/systemd/system/yazio-mcp.service || ! -d /opt/yazio-mcp/dist ]]; then
  echo "Install the service first: sudo bash setup.sh" >&2
  exit 1
fi

for tool in git npm runuser; do
  if ! command -v "$tool" >/dev/null; then
    echo "$tool is required; install it first." >&2
    exit 1
  fi
done

echo "==> Creating build user '$BUILD_USER'"
if ! getent passwd "$BUILD_USER" >/dev/null; then
  # Owns the checkout and runs npm. No login, and no write access to the
  # installed app or the service's state.
  useradd --system --home-dir "$STATE_DIR/home" --no-create-home --shell /usr/sbin/nologin "$BUILD_USER"
  echo "    created"
else
  echo "    already exists, leaving alone"
fi

echo "==> Preparing $STATE_DIR"
install -d -o root -g root -m 0755 "$STATE_DIR"
install -d -o "$BUILD_USER" -g "$BUILD_USER" -m 0755 "$STATE_DIR/home" "$STATE_DIR/repo"

echo "==> Installing the updater"
install -d -o root -g root -m 0755 "$LIB_DIR"
install -o root -g root -m 0755 "$STAGE_DIR/yazio-mcp-update.sh" "$LIB_DIR/update.sh"
install -o root -g root -m 0644 "$STAGE_DIR/yazio-mcp-update.service" "$STAGE_DIR/yazio-mcp-update.timer" \
  /etc/systemd/system/
systemctl daemon-reload

echo "==> First update: clone, install dependencies, build, test (a few minutes on a Pi)"
started="$(date '+%Y-%m-%d %H:%M:%S')"
first_run=ok
systemctl start yazio-mcp-update.service || first_run=failed
journalctl -u yazio-mcp-update.service --since "$started" -o cat --no-pager | tail -n 20

echo "==> Enabling the timer"
systemctl enable --now yazio-mcp-update.timer
systemctl list-timers yazio-mcp-update.timer --no-pager

echo
if [[ $first_run == ok ]]; then
  echo "✅ The updater is running. Follow it with: journalctl -u yazio-mcp-update -f"
  echo "   A deploy restarts the service, which signs connected clients out; sign in again from Claude."
else
  echo "❌ The first update failed (log above). The timer will keep retrying every 5 minutes." >&2
  exit 1
fi
