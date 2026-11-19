#!/bin/sh
# scripts/probe.sh [--once]
#
# Synthetic check + keep-warm for the Merlion fraud line.
#   every 60s (loop mode) or once (--once mode):
#     1. webhook /healthz?deep=1   -> expect ok:true AND sig_enforced:true
#     2. unsigned POST /verify     -> expect HTTP 401 (external proof of sig check)
#     3. MCP initialize            -> expect 200 + protocolVersion
#     4. MCP tools/list            -> expect exactly 4 tools
#   Prints one JSON line per check: {ts, check, ok, ms, detail}.
#   On any failure: prints ALERT and fires a macOS notification (osascript)
#   on the ok->fail transition. --once exits non-zero on failure.
set -u
ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

W="${MERLION_WEBHOOK_URL:-https://merlion-webhook-82dcb044-d.telnyxcompute.com}"
M="${MERLION_MCP_URL:-https://merlion-mcp-dc70ffb9-5.telnyxcompute.com}"

notify() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  osascript -e "display notification \"$1\" with title \"Merlion probe ALERT\" sound name \"Funk\"" 2>/dev/null || true
}

run_checks() {
  W="$W" M="$M" node --input-type=module - <<'EOF'
const W = process.env.W, M = process.env.M;
const line = (check, ok, ms, detail) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), check, ok, ms, ...(detail ? { detail } : {}) }));
const out = await (async () => {
  let anyFail = false;
  // 1. deep health + sig enforced
  {
    const t0 = Date.now();
    try {
      const r = await fetch(`${W}/healthz?deep=1`, { signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      const ok = r.ok && j.ok === true && j.sig_enforced === true;
      line("webhook_deep", ok, Date.now() - t0, ok ? undefined : JSON.stringify(j).slice(0, 200));
      anyFail ||= !ok;
    } catch (e) { line("webhook_deep", false, Date.now() - t0, String(e).slice(0, 200)); anyFail = true; }
  }
  // 2. unsigned /verify must be rejected with 401
  {
    const t0 = Date.now();
    try {
      const r = await fetch(`${W}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ probe: true }),
        signal: AbortSignal.timeout(10000),
      });
      const ok = r.status === 401;
      line("verify_sig_401", ok, Date.now() - t0, ok ? undefined : `HTTP ${r.status}`);
      anyFail ||= !ok;
    } catch (e) { line("verify_sig_401", false, Date.now() - t0, String(e).slice(0, 200)); anyFail = true; }
  }
  // 3. MCP initialize
  {
    const t0 = Date.now();
    try {
      const r = await fetch(`${M}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } } }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await r.json();
      const ok = r.ok && j.result?.protocolVersion != null;
      line("mcp_initialize", ok, Date.now() - t0, ok ? undefined : JSON.stringify(j).slice(0, 200));
      anyFail ||= !ok;
    } catch (e) { line("mcp_initialize", false, Date.now() - t0, String(e).slice(0, 200)); anyFail = true; }
  }
  // 4. MCP tools/list must return 4 tools
  {
    const t0 = Date.now();
    try {
      const r = await fetch(`${M}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await r.json();
      const n = j.result?.tools?.length ?? -1;
      const ok = r.ok && n === 4;
      line("mcp_tools", ok, Date.now() - t0, ok ? undefined : `tools=${n}`);
      anyFail ||= !ok;
    } catch (e) { line("mcp_tools", false, Date.now() - t0, String(e).slice(0, 200)); anyFail = true; }
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), overall: anyFail ? "FAIL" : "OK" }));
  return anyFail;
})();
process.exit(out ? 1 : 0);
EOF
}

FAILED=""
while :; do
  OUT=$(run_checks)
  RC=$?
  echo "$OUT"
  if [ $RC -ne 0 ]; then
    TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "{\"ts\":\"$TS\",\"alert\":true,\"reason\":\"one or more probe checks failed\"}"
    if [ "$FAILED" = "" ]; then
      notify "Merlion probe FAILED — see scripts/probe.sh output"
    fi
    FAILED=1
  else
    FAILED=""
  fi
  [ "$ONCE" = "1" ] && exit $RC
  sleep 60
done
