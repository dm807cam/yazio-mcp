#!/usr/bin/env bash
# Deploy the newest commit of the branch, if it changes the app.
#
# Run every 5 minutes by yazio-mcp-update.timer (see setup-autoupdate.sh).
# Everything that executes code from the repository or npm (fetch, dependency
# install, build, tests) runs as the unprivileged build user. Root only copies
# the finished bundle into place and restarts the service, and never follows a
# symlink out of the build tree. A push to the branch therefore changes the
# app, but not this script or the systemd units: those change only when the
# setup scripts are re-run by hand.
set -euo pipefail

: "${REPO_URL:?}" "${BRANCH:?}"
STATE_DIR="${STATE_DIR:-/var/lib/yazio-mcp-updater}"
APP_DIR="${APP_DIR:-/opt/yazio-mcp}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
SERVICE="${SERVICE:-yazio-mcp.service}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8790/healthz}"
BUILD_USER="${BUILD_USER:-yazio-mcp-build}"

REPO="$STATE_DIR/repo"

# The build user's processes are killed after every build; that must never
# mean root's.
if [[ "$(id -u "$BUILD_USER")" == 0 ]]; then
  echo "BUILD_USER must not be root" >&2
  exit 1
fi

as_builder() {
  runuser -u "$BUILD_USER" -- env HOME="$STATE_DIR/home" npm_config_update_notifier=false "$@"
}

short() {
  printf '%s' "${1:0:7}"
}

# Copy a bundle (dist/ and package.json) from $1 into the app directory. It is
# staged next to the live copy first, so a failed copy never leaves the
# service without its code.
install_app() {
  local from="$1"
  rm -rf "$APP_DIR/dist.new" "$APP_DIR/package.json.new"
  cp -R "$from/dist" "$APP_DIR/dist.new"
  cp -P "$from/package.json" "$APP_DIR/package.json.new"
  chown -R root:root "$APP_DIR/dist.new" "$APP_DIR/package.json.new"
  chmod -R go-w "$APP_DIR/dist.new" "$APP_DIR/package.json.new"
  rm -rf "$APP_DIR/dist"
  mv "$APP_DIR/dist.new" "$APP_DIR/dist"
  mv "$APP_DIR/package.json.new" "$APP_DIR/package.json"
}

healthy() {
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    sleep 2
    if systemctl is-active --quiet "$SERVICE" && curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

if [[ ! -d "$REPO/.git" ]]; then
  echo "Cloning $BRANCH from $REPO_URL"
  as_builder git clone --quiet --branch "$BRANCH" --single-branch "$REPO_URL" "$REPO"
fi
cd "$REPO"
as_builder git fetch --quiet origin
target="$(as_builder git rev-parse "origin/$BRANCH")"

deployed="$(cat "$STATE_DIR/deployed" 2>/dev/null || true)"
rejected="$(cat "$STATE_DIR/rejected" 2>/dev/null || true)"
if [[ "$target" == "$deployed" ]]; then
  exit 0
fi
if [[ "$target" == "$rejected" ]]; then
  echo "Skipping $(short "$target"): it did not come up when last deployed. Waiting for a new commit."
  exit 0
fi

echo "Building $(short "$target")"
as_builder git checkout --quiet --force --detach "$target"
as_builder git clean --quiet -ffdx --exclude=node_modules
# npm ci wipes node_modules and reinstalls everything, which takes minutes on a
# Pi, so only run it when the lockfile changed since the last install.
as_builder sh -c 'cmp -s package-lock.json node_modules/.installed-lockfile ||
  { npm ci --no-audit --no-fund && cp package-lock.json node_modules/.installed-lockfile; }'
as_builder npm run build
as_builder npm test

# Pushes can change this script and the units only through a manual re-run of
# the setup scripts; say so when they drift.
as_builder cmp -s deploy/yazio-mcp.service "$UNIT_DIR/$SERVICE" ||
  echo "Note: deploy/yazio-mcp.service differs from the installed unit; re-run deploy/setup.sh to apply it"
as_builder cmp -s deploy/yazio-mcp-update.sh "${BASH_SOURCE[0]}" ||
  echo "Note: deploy/yazio-mcp-update.sh differs from the installed updater; re-run deploy/setup-autoupdate.sh to apply it"

# Root reads the build output from here on. Stop anything the build left
# running, then accept only plain files and directories, so nothing can swap
# in a symlink and lead root to a file the build user cannot read.
pkill -KILL -u "$BUILD_USER" || true
if [[ -L dist || ! -d dist || -L package.json || ! -f package.json ]] ||
  [[ -n "$(find dist ! -type f ! -type d -print -quit)" ]]; then
  echo "Refusing $(short "$target"): the build output contains something other than plain files" >&2
  exit 1
fi

if diff -rq dist "$APP_DIR/dist" >/dev/null 2>&1 && cmp -s package.json "$APP_DIR/package.json"; then
  echo "$(short "$target") does not change the app; nothing to restart"
  echo "$target" > "$STATE_DIR/deployed"
  exit 0
fi

echo "Deploying $(short "$target")"
rm -rf "$STATE_DIR/previous"
mkdir "$STATE_DIR/previous"
cp -R "$APP_DIR/dist" "$STATE_DIR/previous/dist"
cp -P "$APP_DIR/package.json" "$STATE_DIR/previous/package.json"
install_app "$REPO"
systemctl restart "$SERVICE"
if healthy; then
  echo "$target" > "$STATE_DIR/deployed"
  echo "Deployed $(short "$target")"
  exit 0
fi

# Remember the commit so the next run does not restart into it again.
echo "$target" > "$STATE_DIR/rejected"
echo "$(short "$target") did not come up; rolling back" >&2
install_app "$STATE_DIR/previous"
systemctl restart "$SERVICE"
if healthy; then
  echo "Rolled back to the previous version" >&2
else
  echo "The previous version did not come up either; see journalctl -u $SERVICE" >&2
fi
exit 1
