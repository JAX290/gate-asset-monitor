#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Pre-flight check before switching DATA_MODE to live.
# Verifies the read-only Gate key can actually sign & fetch balances.
# It prints ONLY aggregate info - never the key or secret.
#   bash deploy/verify-live.sh
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

: "${GATE_API_KEY:?GATE_API_KEY is not set}"
: "${GATE_API_SECRET:?GATE_API_SECRET is not set}"

echo "Checking Gate.io API v4 read-only access..."
node - <<'NODE'
const gate = require('./src/gateClient');
(async () => {
  try {
    const tb = await gate.signedRequest({ path: '/wallet/total_balance' });
    const total = tb && tb.total ? tb.total : null;
    if (!total) { console.log('Connected, but no total field returned:', JSON.stringify(tb).slice(0, 300)); process.exit(2); }
    console.log('OK - signed request succeeded');
    console.log('   total amount   :', total.amount, total.currency || '');
    console.log('   account buckets:', Object.keys(tb.details || {}).join(', ') || '(none)');
    const spot = await gate.signedRequest({ path: '/spot/accounts' });
    console.log('   spot currencies:', Array.isArray(spot) ? spot.filter(a => Number(a.available)+Number(a.locked) > 0).length : 'n/a');
    console.log('\nRead-only key works. You can set DATA_MODE=live and restart.');
  } catch (e) {
    console.error('\nFAILED:', e.message);
    console.error('Common causes: wrong key/secret, key is not read-only-permitted,');
    console.error('server IP not in the allowlist, or clock skew (Timestamp must be seconds).');
    process.exit(1);
  }
})();
NODE
