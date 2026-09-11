#!/usr/bin/env bash
# Tests for deploy/yazio-mcp-update.sh, the updater that keeps the Pi on the
# newest commit of the branch.
#
# Runs the real script against a throwaway git repository and app directory.
# systemctl, runuser, pkill, chown, curl, sleep and npm are stubs, so it needs
# no privileges and touches nothing outside a temp directory. The stub build
# copies app.js to dist/http.js; a service whose http.js says CRASH does not
# come up after a restart.
set -euo pipefail

UPDATER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/yazio-mcp-update.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export WORK

passed=0
failed=0

check() {
  local name="$1"
  shift
  if "$@"; then
    passed=$((passed + 1))
    echo "  ✅ $name"
  else
    failed=$((failed + 1))
    echo "  ❌ $name"
  fi
}

fails() {
  ! "$@"
}

stub() {
  printf '#!/usr/bin/env bash\n%s\n' "$2" > "$WORK/bin/$1"
  chmod +x "$WORK/bin/$1"
}

mkdir -p "$WORK/bin"
stub systemctl 'echo "$*" >> "$WORK/systemctl.log"
case "$1" in
  restart) if grep -q CRASH "$APP_DIR/dist/http.js"; then echo down; else echo up; fi > "$WORK/service-state" ;;
  is-active) [ "$(cat "$WORK/service-state")" = up ] ;;
esac'
stub curl '[ "$(cat "$WORK/service-state")" = up ]'
stub runuser 'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift; exec "$@"'
stub pkill 'exit 1'
stub chown 'exit 0'
stub sleep 'exit 0'
stub npm 'echo "$*" >> "$WORK/npm.log"
case "$1" in
  ci) rm -rf node_modules && mkdir node_modules ;;
  run) rm -rf dist && mkdir dist && cp app.js dist/http.js ;;
  test) [ ! -e TESTS_FAIL ] ;;
esac'

# The branch, and a clone to push to it from.
dev() {
  git -C "$WORK/dev" -c user.name=test -c user.email=test@example.invalid "$@"
}
git init --quiet --bare "$WORK/origin.git"
git init --quiet "$WORK/dev"
push() {
  dev add -A
  dev commit --quiet -m "$1"
  dev push --quiet "$WORK/origin.git" HEAD:main
}
printf 'v1\n' > "$WORK/dev/app.js"
printf '{"version":"1"}\n' > "$WORK/dev/package.json"
printf 'lock 1\n' > "$WORK/dev/package-lock.json"
push "v1"

# What setup.sh installed, and a running service.
mkdir -p "$WORK/opt/dist" "$WORK/state" "$WORK/units"
printf 'v1\n' > "$WORK/opt/dist/http.js"
printf '{"version":"1"}\n' > "$WORK/opt/package.json"
echo up > "$WORK/service-state"
: > "$WORK/systemctl.log"
: > "$WORK/npm.log"

update() {
  env PATH="$WORK/bin:$PATH" \
    REPO_URL="$WORK/origin.git" BRANCH=main \
    STATE_DIR="$WORK/state" APP_DIR="$WORK/opt" UNIT_DIR="$WORK/units" \
    SERVICE=yazio-mcp.service HEALTH_URL=http://127.0.0.1:8790/healthz BUILD_USER=nobody \
    bash "$UPDATER" >> "$WORK/updater.log" 2>&1
}
head_commit() { git -C "$WORK/dev" rev-parse HEAD; }
deployed() { cat "$WORK/state/deployed" 2>/dev/null || true; }
installed() { cat "$WORK/opt/dist/http.js"; }
restarts() { grep -c '^restart' "$WORK/systemctl.log" || true; }
installs() { grep -c '^ci' "$WORK/npm.log" || true; }
npm_calls() { wc -l < "$WORK/npm.log" | tr -d ' '; }

echo
echo "1. First run, the branch matches what is installed"
check 'succeeds' update
check 'records the branch head as deployed' [ "$(deployed)" = "$(head_commit)" ]
check 'does not restart the service' [ "$(restarts)" = 0 ]
check 'installs dependencies' [ "$(installs)" = 1 ]

echo
echo "2. Nothing new on the branch"
calls="$(npm_calls)"
check 'succeeds' update
check 'does not build again' [ "$(npm_calls)" = "$calls" ]
check 'does not restart the service' [ "$(restarts)" = 0 ]

echo
echo "3. A commit that changes the app"
printf 'v2\n' > "$WORK/dev/app.js"
push "v2"
check 'succeeds' update
check 'installs the new build' [ "$(installed)" = v2 ]
check 'restarts the service once' [ "$(restarts)" = 1 ]
check 'records the new head as deployed' [ "$(deployed)" = "$(head_commit)" ]
check 'reuses dependencies while the lockfile is unchanged' [ "$(installs)" = 1 ]

echo
echo "4. A commit that leaves the build unchanged"
printf 'docs\n' > "$WORK/dev/README.md"
push "docs only"
check 'succeeds' update
check 'does not restart the service' [ "$(restarts)" = 1 ]
check 'records the new head as deployed' [ "$(deployed)" = "$(head_commit)" ]

echo
echo "5. A commit whose tests fail"
printf 'v3\n' > "$WORK/dev/app.js"
touch "$WORK/dev/TESTS_FAIL"
push "v3, tests fail"
check 'reports the failure' fails update
check 'keeps the running version' [ "$(installed)" = v2 ]
check 'does not restart the service' [ "$(restarts)" = 1 ]
check 'does not record it as deployed' [ "$(deployed)" != "$(head_commit)" ]

echo
echo "6. A commit whose app does not come up"
rm "$WORK/dev/TESTS_FAIL"
printf 'v4 CRASH\n' > "$WORK/dev/app.js"
push "v4 crashes"
check 'reports the failure' fails update
check 'rolls back to the previous version' [ "$(installed)" = v2 ]
check 'leaves the service running' [ "$(cat "$WORK/service-state")" = up ]
restarts_after_rollback="$(restarts)"
update || true
check 'does not retry the same commit' [ "$(restarts)" = "$restarts_after_rollback" ]

echo
echo "7. A fix after the failed commit"
printf 'v5\n' > "$WORK/dev/app.js"
push "v5"
check 'succeeds' update
check 'deploys it' [ "$(installed)" = v5 ]
check 'records it as deployed' [ "$(deployed)" = "$(head_commit)" ]

echo
echo "8. A commit that changes the lockfile"
printf 'lock 2\n' > "$WORK/dev/package-lock.json"
push "bump dependencies"
check 'succeeds' update
check 'reinstalls dependencies' [ "$(installs)" = 2 ]

echo
echo "9. A commit whose build output contains a symlink"
printf 'v6\n' > "$WORK/dev/app.js"
ln -s /etc/hosts "$WORK/dev/package.json.link"
rm "$WORK/dev/package.json"
mv "$WORK/dev/package.json.link" "$WORK/dev/package.json"
push "v6, package.json is a symlink"
check 'refuses to install it' fails update
check 'keeps the running version' [ "$(installed)" = v5 ]

if [ "$failed" -ne 0 ]; then
  echo
  echo "--- updater output ---"
  cat "$WORK/updater.log"
fi
echo
if [ "$failed" -eq 0 ]; then echo "✅ $passed passed, 0 failed"; else echo "❌ $passed passed, $failed failed"; fi
[ "$failed" -eq 0 ]
