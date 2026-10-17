#!/usr/bin/env bash
# One engine build on the server: pull the latest code, sync the shared
# engine, build every connected league, store it. Run by dhq-engine.service.
# Same steps as .github/workflows/engine-build.yml, plus a lease so GitHub's
# fallback never builds at the same time.
set -euo pipefail

# Wrapped in main so bash reads all of it before the git reset below
# rewrites this very file.
main() {
  local BASE=/opt/dhq
  exec 9>"$BASE/build.lock"
  flock -n 9 || { echo "another build is running; skipping"; exit 0; }

  git -C "$BASE/app" fetch -q origin main && git -C "$BASE/app" reset -q --hard origin/main
  git -C "$BASE/DHQ-Shared" fetch -q origin && git -C "$BASE/DHQ-Shared" reset -q --hard origin/HEAD
  cd "$BASE/app"
  DHQ_SHARED_SOURCE="$BASE/DHQ-Shared" node scripts/sync-reconai-shared.cjs

  # A dry run stores nothing, so it takes no lease.
  if [[ " $* " != *" --dry "* ]]; then
    node server/engine/host/lease.js take || echo "lease not taken (continuing)"
    trap 'node /opt/dhq/app/server/engine/host/lease.js clear || true' EXIT
  fi
  echo "building at $(git rev-parse --short HEAD)"
  ENGINE_RUNNER=server timeout 25m node --max-old-space-size=3072 server/engine/run.js "$@"
}
main "$@"; exit
