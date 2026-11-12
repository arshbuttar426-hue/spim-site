#!/bin/sh
# seam-load-test.sh — measure the local SPIM site under sustained and concurrent load.
#
#   tools/seam-load-test.sh
#
# Runs four profiles against the real Pages Functions on 127.0.0.1:
#   baseline/open   seam/open   baseline/closed   seam/closed
#
# The open model ramps arrivals/sec; the closed model holds thousands of VUs.
# Each profile gets a fresh server and a freshly seeded KV, so prekey consumption
# and ack deletions cannot leak between runs.
#
# Safety: every URL is loopback. The script refuses anything else, and never
# touches production, deploy.sh, or wrangler.
set -eu

cd "$(dirname "$0")/.."
ROOT=$(pwd)
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$ROOT/artifacts/load-$STAMP"
DATA="$OUT/data.json"
mkdir -p "$OUT"

command -v k6 >/dev/null 2>&1 || { echo "k6 is required (brew install k6)" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

WASM_DIR=${SEAM_WASM_DIR:-${TMPDIR:-/tmp}/seam-load-node}
if [ ! -f "$WASM_DIR/spim_wasm.js" ]; then
  echo "== building node WASM into $WASM_DIR"
  ( cd "$ROOT/../spim-memory" && wasm-pack build \
      --target nodejs \
      --out-dir "$WASM_DIR" \
      --out-name spim_wasm \
      --no-typescript --no-pack --no-default-features --features wasm,seam >/dev/null )
fi

echo "== preparing load data"
SEAM_WASM_DIR="$WASM_DIR" node tools/seam-load-prepare.mjs "$DATA"

RATE_START=${RATE_START:-10}
RATE_END=${RATE_END:-300}
RAMP=${RAMP:-30s}
HOLD=${HOLD:-20s}
VUS=${VUS:-2000}
CLOSED_RAMP=${CLOSED_RAMP:-30s}
CLOSED_HOLD=${CLOSED_HOLD:-20s}

run_one() {
  target=$1
  mode=$2
  label="$target-$mode"
  portfile="$OUT/$label.base"
  serverlog="$OUT/$label.server.log"
  summary="$OUT/$label.summary.json"
  k6log="$OUT/$label.k6.log"

  rm -f "$portfile"
  node tools/seam-load-server.mjs "$DATA" "$portfile" >"$serverlog" 2>&1 &
  server_pid=$!
  trap 'kill "$server_pid" 2>/dev/null || true' EXIT INT TERM

  i=0
  while [ ! -s "$portfile" ] && [ "$i" -lt 100 ]; do
    sleep 0.1
    i=$((i + 1))
  done
  [ -s "$portfile" ] || { echo "server failed for $label" >&2; cat "$serverlog" >&2; exit 1; }
  BASE=$(cat "$portfile")
  case "$BASE" in
    http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
    *) echo "refusing non-loopback base: $BASE" >&2; exit 1 ;;
  esac

  echo "== $label  $BASE"
  set +e
  if [ "$mode" = "closed" ]; then
    BASE_URL="$BASE" SEAM_DATA="$DATA" TARGET="$target" MODE=closed \
      VUS="$VUS" RAMP="$CLOSED_RAMP" HOLD="$CLOSED_HOLD" \
      k6 run --quiet --summary-export "$summary" \
        --summary-trend-stats "avg,min,med,p(90),p(95),p(99),max" \
        tools/seam-load.k6.js >"$k6log" 2>&1
  else
    BASE_URL="$BASE" SEAM_DATA="$DATA" TARGET="$target" MODE=open \
      RATE_START="$RATE_START" RATE_END="$RATE_END" RAMP="$RAMP" HOLD="$HOLD" \
      k6 run --quiet --summary-export "$summary" \
        --summary-trend-stats "avg,min,med,p(90),p(95),p(99),max" \
        tools/seam-load.k6.js >"$k6log" 2>&1
  fi
  k6_status=$?
  set -e

  curl -s "$BASE/__test/stats" >"$OUT/$label.stats.json" || true
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  trap - EXIT INT TERM

  echo "   k6 exit $k6_status; summary $summary"
  [ -f "$summary" ] || { echo "no summary for $label; k6 log:" >&2; cat "$k6log" >&2; exit 1; }
}

run_one baseline open
run_one seam open
run_one baseline closed
run_one seam closed

echo "== report"
node tools/seam-load-report.mjs "$OUT" | tee "$OUT/report.txt"
echo
echo "artifacts: $OUT"
