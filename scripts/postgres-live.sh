#!/bin/sh
# PostgreSQL lifecycle helper for the autobuild pipeline.
# Mirrors the scripts/browser-smoke.sh provisioning pattern:
#   install        — run as root during provisioning (apt install + cluster start + password seed)
#   ensure-running — run before the gated suites (idempotent start, safe after rehydrates)
set -eu

usage() {
  echo "usage: $0 {install|ensure-running}" >&2
  exit 2
}

detect_version() {
  VERSION="$(ls /usr/lib/postgresql 2>/dev/null | sort -n | tail -1)"
  if [ -z "$VERSION" ]; then
    echo 'postgres-live failure: postgresql version not found under /usr/lib/postgresql' >&2
    exit 1
  fi
}

cmd_install() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq postgresql
  # Derive the installed major version only after the apt install: on a fresh
  # sandbox /usr/lib/postgresql does not exist yet, so an eager top-level
  # derivation would yield an empty VERSION instead of aborting.
  detect_version
  pg_ctlcluster "$VERSION" main start
  sudo -u postgres psql -qtc "ALTER ROLE postgres PASSWORD 'postgres'"
}

cmd_ensure_running() {
  detect_version
  if ! pg_isready -q -h 127.0.0.1 -p 5432; then
    sudo pg_ctlcluster "$VERSION" main start
  fi
  if ! pg_isready -q -h 127.0.0.1 -p 5432; then
    echo 'postgres-live failure: cluster did not become ready after start' >&2
    exit 1
  fi
  # Re-seed the role password idempotently. A rehydrated workspace can come
  # back with the cluster running but the install step's password seed gone,
  # and the gated suites authenticate with this fixed credential, not the
  # bootstrap one.
  sudo -u postgres psql -qtc "ALTER ROLE postgres PASSWORD 'postgres'"
}

case "${1:-}" in
  install) cmd_install ;;
  ensure-running) cmd_ensure_running ;;
  *) usage ;;
esac
