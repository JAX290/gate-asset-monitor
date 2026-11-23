#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Launcher for the Tailscale-only deployment.
#
# Resolves this node's Tailscale IPv4 at boot and binds ONLY to that address,
# so the public / eth0 / docker interfaces never listen on PORT at all.
# Refuses to start if Tailscale is not ready (never silently falls back to
# 0.0.0.0, which would expose the dashboard to the internet).
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

TAILSCALE_BIN="${TAILSCALE_BIN:-/usr/bin/tailscale}"
if [ ! -x "$TAILSCALE_BIN" ]; then
  TAILSCALE_BIN="$(command -v tailscale || true)"
fi
if [ -z "$TAILSCALE_BIN" ] || [ ! -x "$TAILSCALE_BIN" ]; then
  echo "[start] tailscale CLI not found; refusing to start" >&2
  exit 1
fi

TS_IP="$("$TAILSCALE_BIN" ip -4 2>/dev/null | head -n1 | tr -d '[:space:]')"
if [ -z "$TS_IP" ]; then
  echo "[start] Tailscale IPv4 unavailable; refusing to start on 0.0.0.0" >&2
  exit 1
fi

export HOST="$TS_IP"
export TAILSCALE_ONLY=true
export PORT="${PORT:-8787}"

NODE_BIN="$APP_DIR/.runtime/node/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "[start] missing runtime: $NODE_BIN (run deploy/install-vps.sh first)" >&2
  exit 1
fi

echo "[start] Tailscale-only bind -> http://$TS_IP:$PORT"
exec "$NODE_BIN" src/server.js
