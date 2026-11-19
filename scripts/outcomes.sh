#!/bin/sh
# scripts/outcomes.sh [hours]  (default: 2)
#
# Counter signal derived from function logs: counts by outcome, counts by
# route/tool, and p95 duration per route, over the last N hours.
# NOTE: `telnyx-edge logs` one-shot reads cap at 24h / 250 lines per function —
# long windows under load are sampled, not complete.
set -u
HOURS="${1:-2}"

W=$(telnyx-edge logs merlion-webhook --type runtime --since "${HOURS}h" --last 250 --json 2>/dev/null || true)
M=$(telnyx-edge logs merlion-mcp --type runtime --since "${HOURS}h" --last 250 --json 2>/dev/null || true)

W="$W" M="$M" HOURS="$HOURS" node - <<'EOF'
const parse = (s) => {
  try { return JSON.parse(s); } catch { return { lines: [] }; }
};
const rows = [];
for (const raw of [process.env.W, process.env.M]) {
  const d = parse(raw);
  for (const l of d.lines ?? d.logs ?? d.data ?? []) {
    if (typeof l.message !== "string" || !l.message.startsWith("{")) continue;
    try { rows.push(JSON.parse(l.message)); } catch { /* skip */ }
  }
}
const byOutcome = {};
const byRoute = {};
const durs = {};
for (const m of rows) {
  const o = m.outcome ?? "unknown";
  byOutcome[o] = (byOutcome[o] ?? 0) + 1;
  const rk = `${m.svc}:${m.route}:${o}`;
  byRoute[rk] = (byRoute[rk] ?? 0) + 1;
  if (typeof m.duration_ms === "number") (durs[`${m.svc}:${m.route}`] ??= []).push(m.duration_ms);
}
const p95 = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
};
console.log(JSON.stringify({
  ts: new Date().toISOString(),
  window_hours: +process.env.HOURS,
  lines_analysed: rows.length,
  by_outcome: byOutcome,
  by_route_outcome: byRoute,
  p95_duration_ms_by_route: Object.fromEntries(Object.entries(durs).map(([k, v]) => [k, p95(v)])),
}, null, 2));
EOF
