# Merlion Bank scam-response hotline (fictional)

## Observability

One voice call crosses four runtimes: the Telnyx AI Assistant (model + workflow),
`merlion-webhook` (/dv, /verify, /healthz, /admin/reset), `merlion-mcp` (MCP
tools), and StatefulActors (`CustomerActor`, `CallContext`). Everything below is
how we see it.

### What's instrumented

| Signal | Where it lives | Script |
| --- | --- | --- |
| Structured JSON logs (one line per hop: `ts, level, svc, route, trace_id, conversation_id, caller_masked, customer_id, outcome, status, duration_ms, kv_ms, actor_ms, err`) | `telnyx-edge logs <fn> --type runtime` | — |
| One `trace_id` (= `call_control_id`) across Assistant → Functions → Actors → MCP | same logs, plus platform invocations | `scripts/trace.sh <conversation_id>` |
| Deep health (KV read + actor ping + MCP self-check + `sig_enforced`) with no auth/PII | `GET /healthz?deep=1` on both functions | `scripts/probe.sh` |
| Synthetic probe every 60 s (also keep-warm): deep health, unsigned `/verify` must 401, MCP initialize + tools/list = 4 | laptop loop + GitHub Actions cron (5 min minimum, `.github/workflows/probe.yml`) | `scripts/probe.sh [--once]` |
| Platform metrics: request count, 2xx/4xx/5xx, p50/p95/p99, CPU/mem | `telnyx-edge metrics <fn> --json` | `scripts/metrics.sh` |
| Outcome counters (`ok/fallback/miss/verified/failed/locked/not_found/denied`) + p95 per route, derived from logs | logs | `scripts/outcomes.sh [hours]` |

`trace_id` linkage: `/dv` gets `call_control_id` in the webhook payload; `/verify`
and the MCP URL receive it via `{{call_control_id}}` in the shared-tool preset
fields and the assistant's MCP server URL. `scripts/trace.sh` pivots from a
conversation to that ID via the `/dv` log line (`conversation_id` → `trace_id`).

### "Broken within a minute" — the answer

The worst failure on this stack is **silent**: the dynamic-variables webhook
fires once per call and, on timeout, the call carries on with builder defaults —
it *sounds* fine. The cover is:

- **ALERT within 60 s.** `scripts/probe.sh` prints one JSON line per check and
  fires a macOS notification on the first failure; GitHub Actions runs
  `probe.sh --once` every 5 min as a laptop-independent net. (Production: a
  60 s external synthetic, e.g. Datadog Synthetics, with paging — the Actions
  cron only approximates it.)
- **Silent-failure modes watched explicitly:**
  - `/dv` timeout/5xx → `outcome=fallback` (still HTTP 200) is counted in
    `scripts/outcomes.sh` and the whole deep-health probe fails loudly.
  - Signature bypass left on (`DEV_SKIP_SIG`) → `/healthz?deep=1` reports
    `sig_enforced:false` (its `ok` flips to false) **and** the probe's unsigned
    `/verify` check expects 401. Drift alarms within a minute.
  - Transfer reaching voicemail counts as success on the platform — surfacing
    rule: watch transcripts for "specialist is busy" *not* being said, and the
    escalation edges; no metric shields this one, the trace shows it.
- **What to look at first:** `scripts/trace.sh <conversation_id>` on the failing
  call — it merges transcript turns, tool calls and both functions' log lines
  onto one timeline, so you see whether the failure was the webhook, the actor,
  MCP, or the model. Then `scripts/metrics.sh` for the platform-rate view
  (webhook p95 must stay well under the 3000 ms `/dv` timeout; ALERTs at
  1500 ms).

Cost notes for interpreting what you see (from the dogfooding log): KV and
`env.SECRETS.get()` are ~1 s sidecar RPCs while actor calls are ~30–60 ms warm —
all mid-call paths avoid KV/secrets, and `/healthz?deep=1`'s `kv_ms`/`actor_ms`
fields make the cost shapes visible on demand.
