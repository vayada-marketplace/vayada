#!/usr/bin/env bash
# Installs Playwright's headless Chromium and the system packages it needs, for the PR Checks
# browser jobs. Same result as `npx playwright install --with-deps chromium` minus the full Chrome
# build the headless specs never start, with each download retried after a pause (VAY-2314):
#
# - System packages: the runner's Azure Ubuntu mirror sometimes serves them at a few kB/s (10+
#   minute installs) or another apt source answers 403. Playwright's apt-get runs download-only,
#   so a slow attempt can be stopped safely; the next one uses archive.ubuntu.com and keeps what is
#   already downloaded. The packages then install offline, once, without a retry.
# - The browser: Playwright tries its one CDN host for Chrome builds five times back to back, which
#   a CDN fault of a minute outlasts (ERR_TLS_CERT_ALTNAME_INVALID on 2026-10-22). It is retried
#   only when it fails: Playwright already drops a stalled connection, and a stopped download
#   would start over.
#
# Each retry prints an "Infra retry" warning annotation.
set -euo pipefail

ATTEMPTS=3
DOWNLOAD_ONLY=/etc/apt/apt.conf.d/99-playwright-download-only
# Where apt keeps downloaded packages (scripts/ci/install-playwright-chromium.test.mjs points it
# at a temporary folder).
ARCHIVES=${PLAYWRIGHT_APT_ARCHIVES:-/var/cache/apt/archives}

# retry <what> <seconds> <before next attempt> <command...>: up to $ATTEMPTS attempts, 30 s and
# 60 s apart. With <seconds> above 0, every attempt but the last stops after that long; the last
# one has no limit, so a slow download still finishes as it did before.
retry() {
  local what=$1 limit=$2 before_next=$3 attempt
  shift 3
  for attempt in $(seq 1 "$ATTEMPTS"); do
    if [ "$attempt" -eq "$ATTEMPTS" ]; then
      "$@" && return 0
      echo "::error title=Infra retry::$what failed $ATTEMPTS times"
      return 1
    fi
    if [ "$limit" -gt 0 ]; then
      timeout "$limit" "$@" && return 0
      echo "::warning title=Infra retry::$what failed or took over ${limit}s (attempt $attempt of $ATTEMPTS)"
    else
      "$@" && return 0
      echo "::warning title=Infra retry::$what failed (attempt $attempt of $ATTEMPTS)"
    fi
    "$before_next"
    sleep $((attempt * 30))
  done
}

# Stopping an attempt leaves its apt-get running: Playwright starts it through sudo, and sudo does
# not pass on a signal from its own process group. It would go on with the slow download and keep
# apt's lock, which fails every later attempt (seen on a runner, 2026-10-23), so stop it first:
# Playwright's `sh -c "apt-get update && apt-get install …"` too, or the install could start just
# after. The bracket keeps pkill from matching its own sudo.
stop_apt() {
  sudo pkill -f "[a]pt-get update && apt-get install" || true
  sudo pkill -x apt-get || true
  for _ in $(seq 1 30); do
    pgrep -x apt-get >/dev/null || return 0
    sleep 1
  done
  sudo pkill -KILL -x apt-get || true
}

# Before another package attempt: stop the last one's apt-get and leave the Azure mirror, which the
# runner lists first (mirror+file: sources); the backend job skips it too.
next_package_attempt() {
  stop_apt
  if [ -f /etc/apt/apt-mirrors.txt ]; then
    sudo sed -i 's|http://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' \
      /etc/apt/apt-mirrors.txt
  fi
}

sudo apt-get clean
trap 'sudo rm -f "$DOWNLOAD_ONLY"' EXIT
echo 'APT::Get::Download-Only "true";' | sudo tee "$DOWNLOAD_ONLY" >/dev/null
retry "System packages for Chromium" 150 next_package_attempt npx playwright install-deps chromium
sudo rm -f "$DOWNLOAD_ONLY"
shopt -s nullglob
packages=("$ARCHIVES"/*.deb)
shopt -u nullglob
if [ "${#packages[@]}" -gt 0 ]; then
  sudo apt-get install -y --no-install-recommends "${packages[@]}"
fi

retry "Chromium download" 0 true npx playwright install --only-shell chromium
