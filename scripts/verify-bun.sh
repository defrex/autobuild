#!/usr/bin/env bash
set -euo pipefail
# Keep this on the version the maintainer runs locally.
required_version=1.4.4
if (( $# == 0 )); then
  echo 'usage: verify-bun.sh command [args...]' >&2
  exit 2
fi
if [[ $(bun --version) == "$required_version" ]]; then
  exec "$@"
fi
prefix="$HOME/.cache/autobuild-repository-verify-bun"
workspace=$(cd "$(dirname "$0")/.." && pwd -P)
mkdir -p "$prefix"
prefix=$(cd "$prefix" && pwd -P)
case "$prefix/" in
  "$workspace/"*) echo 'verify Bun cache must be outside the workspace' >&2; exit 1 ;;
esac
selected="$prefix/node_modules/.bin/bun"
(
  # Symlink creation is exclusive on macOS and Linux. Unlike mkdir, the
  # sandbox's uutils ln does not report success for concurrent existing paths.
  lock="$prefix/install.lock.link"
  attempts=0
  until ln -s "$$" "$lock" 2>/dev/null; do
    attempts=$((attempts + 1))
    if (( attempts >= 300 )); then
      echo "timed out waiting for verify Bun installation lock: $lock" >&2
      exit 1
    fi
    sleep 1
  done
  trap 'rm "$lock"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [[ ! -x "$selected" ]] || [[ $("$selected" --version) != "$required_version" ]]; then
    npm install --prefix "$prefix" --no-save "bun@$required_version"
  fi
  if [[ ! -x "$selected" ]] || [[ $("$selected" --version) != "$required_version" ]]; then
    echo 'verify Bun installation has the wrong version' >&2
    exit 1
  fi
)
export PATH="$prefix/node_modules/.bin:$PATH"
exec "$@"
