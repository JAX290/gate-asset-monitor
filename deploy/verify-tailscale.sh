#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Post-deployment checks for the Tailscale-only setup.
# Run on the VPS. Safe: read-only except for one local curl.
# ---------------------------------------------------------------------------
set -uo pipefail
APP_DIR="${APP_DIR:-/opt/gate-asset-monitor}"
PORT="${PORT:-8787}"
SERVICE="gate-asset-monitor"
TS_BIN="$(command -v tailscale || echo /usr/bin/tailscale)"
TS_IP="$("$TS_BIN" ip -4 2>/dev/null | head -n1 | tr -d '[:space:]')"

echo "=== service ==="
systemctl is-active "$SERVICE" 2>/dev/null || echo "INACTIVE"
echo ""
echo "=== listening sockets on $PORT (should show ONLY the 100.x address) ==="
ss -tlnp 2>/dev/null | grep -E ":${PORT}\b" || echo "nothing listening!"

echo ""
echo "=== 1) Tailscale address (expect 200 / 401 depending on auth) ==="
curl -s -o /dev/null -w "  http://$TS_IP:$PORT/  -> %{http_code}\n" --max-time 8 "http://$TS_IP:$PORT/" || echo "  FAILED"

echo ""
echo "=== 2) public / eth0 addresses (expect connection refused) ==="
for ip in $(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -v '^100\.'); do
  if code="$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 4 "http://$ip:$PORT/" 2>/dev/null)" && [ "$code" != "000" ]; then
    echo "  http://$ip:$PORT/  -> $code  (unexpected: reachable!)"
  else
    echo "  http://$ip:$PORT/  -> REFUSED (no listener, as intended)"
  fi
done

echo ""
echo "=== 3) source-IP allowlist active ==="
TOKEN="$(grep '^ACCESS_TOKEN=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2-)"
if [ -n "$TOKEN" ]; then
  curl -s -c /tmp/gam_verify_cookie -X POST -H 'Content-Type: application/json' \
    -d "{\"token\":\"$TOKEN\"}" "http://$TS_IP:$PORT/api/auth/login" >/dev/null
  curl -s -b /tmp/gam_verify_cookie "http://$TS_IP:$PORT/api/summary" | \
    grep -o '"tailscaleOnly":[a-z]*' | head -1 | sed 's/^/  summary: /'
  rm -f /tmp/gam_verify_cookie
fi

echo ""
echo "=== 4) existing services still running ==="
systemctl is-active tailscaled docker 2>/dev/null | sed 's/^/  /'
docker ps --format '  {{.Names}}: {{.Status}}' 2>/dev/null | head -10
echo ""
