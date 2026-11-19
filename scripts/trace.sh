#!/bin/sh
# scripts/trace.sh <conversation_id>
#
# Distributed-tracing demo: follow ONE conversation across
#   Assistant -> webhook Function (/dv, /verify) -> CustomerActor -> MCP server.
#
# 1. Fetches the transcript (GET /v2/ai/conversations/{id}/messages, page max 100).
# 2. Finds the call_control_id from the merlion-webhook /dv log line whose
#    conversation_id matches (fallback: conversation metadata.call_control_id).
# 3. Pulls runtime logs from BOTH functions and keeps lines with that trace_id.
# 4. Prints ONE merged timeline, oldest first: transcript turns, tool calls and
#    function log lines (svc, route|tool, outcome, duration_ms, actor_ms).
set -eu
CID="${1:?usage: trace.sh <conversation_id>}"
KEY="${TELNYX_API_KEY:-}"
if [ -z "$KEY" ]; then
  KEY=$(sed -n 's/^api_key = "\(.*\)"/\1/p' "$HOME/.telnyx-edge/config.toml")
fi
TMP="${TMPDIR:-/tmp}/merlion-trace-$CID"
mkdir -p "$TMP"

curl -sS "https://api.telnyx.com/v2/ai/conversations/$CID/messages?page%5Bsize%5D=100" \
  -H "Authorization: Bearer $KEY" > "$TMP/messages.json"
curl -sS "https://api.telnyx.com/v2/ai/conversations/$CID" \
  -H "Authorization: Bearer $KEY" > "$TMP/conversation.json"
telnyx-edge logs merlion-webhook --type runtime --since 2h --last 250 --json 2>/dev/null > "$TMP/logs-webhook.json" || true
telnyx-edge logs merlion-mcp --type runtime --since 2h --last 250 --json 2>/dev/null > "$TMP/logs-mcp.json" || true

CID="$CID" TMP="$TMP" node --input-type=module - <<'EOF'
import { readFileSync } from "node:fs";
const CID = process.env.CID, TMP = process.env.TMP;
const J = (f) => JSON.parse(readFileSync(f, "utf8"));

const parseLogMessages = (file) => {
  let d;
  try { d = J(file); } catch { return []; }
  return (d.lines ?? d.logs ?? d.data ?? [])
    .filter((l) => typeof l.message === "string" && l.message.startsWith("{"))
    .map((l) => { try { return JSON.parse(l.message); } catch { return null; } })
    .filter(Boolean);
};

// 1) locate the call_control_id: /dv log line with conversation_id === CID
const wh = parseLogMessages(`${TMP}/logs-webhook.json`);
const mcp = parseLogMessages(`${TMP}/logs-mcp.json`);
let traceId = null;
const dv = wh.find((m) => m.route === "/dv" && m.conversation_id === CID);
if (dv) traceId = dv.trace_id;

// fallback: conversation metadata
if (!traceId) {
  try {
    const conv = J(`${TMP}/conversation.json`);
    traceId = (conv.data ?? conv)?.metadata?.call_control_id ?? null;
  } catch { /* ignore */ }
}

if (!traceId) {
  console.error(`no call_control_id found for conversation ${CID}`);
  console.error("(no /dv log line with this conversation_id in the last 2h, and no metadata.call_control_id)");
  process.exit(1);
}

// 2) merge all event streams, oldest first
const fmt = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "--:--:--" : d.toISOString().slice(11, 23);
};
const events = [];

// transcript (API: newest first)
for (const m of (J(`${TMP}/messages.json`).data ?? [])) {
  const t = m.created_at ?? m.sent_at;
  const node = m.metadata?.flow_node_id ? ` [${m.metadata.flow_node_id}]` : "";
  if (Array.isArray(m.tool_calls))
    for (const tc of m.tool_calls) {
      const fn = tc.function ?? {};
      events.push({ t, line: `${fmt(t)}  transcript${node}  CALLS ${fn.name}(${String(fn.arguments ?? "").slice(0, 160)})` });
    }
  if (m.role === "tool") {
    events.push({ t, line: `${fmt(t)}  transcript${node}  tool-result ${String(m.text ?? "").slice(0, 160)}` });
  } else if ((m.text ?? "").trim()) {
    events.push({ t, line: `${fmt(t)}  ${(m.name ?? m.role).toLowerCase()}${node}  ${String(m.text).replace(/\n/g, " ").slice(0, 160)}` });
  }
}

// function logs filtered by trace_id
for (const [svc, rows] of [["webhook", wh], ["mcp", mcp]]) {
  for (const m of rows.filter((m) => m.trace_id === traceId)) {
    const bits = [
      `${fmt(m.ts)}  fn:${svc}`.padEnd(30),
      `${m.svc}:${m.route}`.padEnd(34),
      `outcome=${m.outcome}`.padEnd(20),
      `status=${m.status}`,
      `duration_ms=${m.duration_ms}`,
      m.actor_ms != null ? `actor_ms=${m.actor_ms}` : null,
      m.kv_ms != null ? `kv_ms=${m.kv_ms}` : null,
      m.err ? `err="${m.err}"` : null,
    ].filter(Boolean);
    events.push({ t: m.ts, line: bits.join(" ") });
  }
}

events.sort((a, b) => String(a.t).localeCompare(String(b.t)));
console.log(`conversation ${CID}  ↔  call_control_id ${traceId}`);
console.log("─".repeat(72));
for (const e of events) console.log(e.line);
EOF
