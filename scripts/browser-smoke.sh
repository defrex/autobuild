#!/bin/sh

set -u

MARKER='AUTOBUILD_BROWSER_SMOKE_RENDERED'
ADAPTER_BUN='/opt/autobuild-runtime/node_modules/.bin/bun'
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORK_DIR=''
SERVER_PID=''

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

resolve_executable() {
  candidate=$1
  case "$candidate" in
    */*)
      [ -x "$candidate" ] && printf '%s\n' "$candidate"
      ;;
    *)
      command -v "$candidate" 2>/dev/null || true
      ;;
  esac
}

if [ -z "${CHROMIUM_BIN:-}" ]; then
  echo 'browser-smoke prerequisite failure: CHROMIUM_BIN is not set' >&2
  exit 2
fi
CHROMIUM=$(resolve_executable "$CHROMIUM_BIN")
if [ -z "$CHROMIUM" ]; then
  echo "browser-smoke prerequisite failure: CHROMIUM_BIN is not executable: $CHROMIUM_BIN" >&2
  exit 2
fi

if [ "${BUN_BIN+x}" = x ]; then
  if [ -z "$BUN_BIN" ]; then
    echo 'browser-smoke prerequisite failure: BUN_BIN is set but empty' >&2
    exit 2
  fi
  BUN=$(resolve_executable "$BUN_BIN")
else
  BUN=$(resolve_executable "$ADAPTER_BUN")
  if [ -z "$BUN" ]; then
    BUN=$(resolve_executable bun)
  fi
fi
if [ -z "$BUN" ]; then
  echo 'browser-smoke prerequisite failure: no executable Bun runtime found (set BUN_BIN)' >&2
  exit 2
fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/autobuild-browser-smoke.XXXXXX") || {
  echo 'browser-smoke prerequisite failure: could not create temporary workspace' >&2
  exit 2
}
READY_FILE="$WORK_DIR/port"
SERVER_LOG="$WORK_DIR/server.log"
DOM_FILE="$WORK_DIR/dom.html"
BROWSER_LOG="$WORK_DIR/browser.log"

"$BUN" "$SCRIPT_DIR/browser-smoke-server.ts" "$READY_FILE" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

poll=0
while [ ! -s "$READY_FILE" ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SERVER_PID" 2>/dev/null || true
    echo 'browser-smoke server startup failure: page server exited before becoming ready' >&2
    cat "$SERVER_LOG" >&2
    exit 3
  fi
  poll=$((poll + 1))
  if [ "$poll" -ge 100 ]; then
    echo 'browser-smoke server startup failure: timed out waiting for page server readiness' >&2
    cat "$SERVER_LOG" >&2
    exit 3
  fi
  sleep 0.1
done

PORT=$(cat "$READY_FILE")
case "$PORT" in
  ''|*[!0-9]*)
    echo "browser-smoke server startup failure: invalid announced port: $PORT" >&2
    cat "$SERVER_LOG" >&2
    exit 3
    ;;
esac
URL="http://127.0.0.1:$PORT/"

"$CHROMIUM" --headless --no-sandbox --disable-gpu --dump-dom "$URL" >"$DOM_FILE" 2>"$BROWSER_LOG"
code=$?
if [ "$code" -ne 0 ]; then
  echo "browser-smoke browser failure: headless browser exited nonzero while rendering $URL" >&2
  echo "browser exit status: $code" >&2
  cat "$BROWSER_LOG" >&2
  exit 4
fi

if ! grep -F "$MARKER" "$DOM_FILE" >/dev/null; then
  echo "browser-smoke render mismatch: expected marker '$MARKER' in rendered DOM from $URL" >&2
  echo '--- browser stderr ---' >&2
  cat "$BROWSER_LOG" >&2
  echo '--- rendered DOM ---' >&2
  cat "$DOM_FILE" >&2
  exit 5
fi

printf 'browser-smoke passed: rendered marker %s at %s\n' "$MARKER" "$URL"
