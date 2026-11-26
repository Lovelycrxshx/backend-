#!/usr/bin/env bash
# Bring the whole thing up on a preview-friendly port, recovering from a paused
# sandbox: a stale service.lock and a half-dead child are the usual leftovers.
#
#   ./scripts/dev.sh            # dashboard on :8080, gateway on :3000
#   DASHBOARD_PORT=8080 ./scripts/dev.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DASHBOARD_PORT="${DASHBOARD_PORT:-8080}"
GATEWAY_PORT="${GATEWAY_PORT:-3000}"
export OFM_HOME="${OFM_HOME:-$PWD/.ofm}"
export OFM_PORT="${OFM_PORT:-18900}"

# A sandbox pause can leave the child's pid file behind. If nothing answers on
# the port, the lock belongs to a process that no longer exists.
if ! curl -sf -m 2 "http://127.0.0.1:$OFM_PORT/health" >/dev/null 2>&1; then
  rm -f "$OFM_HOME/service.lock"
fi

if [ ! -f vendor/dsh-our-free-model/packages/standalone/cli.mjs ]; then
  echo "[dev] fetching the our-free-model service…"
  node scripts/ofm-fetch.mjs
fi

echo "[dev] dashboard → http://0.0.0.0:$DASHBOARD_PORT  (gateway :$GATEWAY_PORT)"
exec node dashboard/server.js
