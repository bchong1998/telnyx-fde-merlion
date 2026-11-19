> Planning doc drafted with Claude Code (Opus) as a design/review aid. All solution code is written in OpenCode with Telnyx Inference.

# Step 2: Architecture, scam-response hotline (fictional "Merlion Bank")

Facts marked **[doc]** come from the Telnyx docs, read 19 Nov. Items marked **[spike]** are unverified and need checking tonight.

## 0. Platform facts that shape the design
- **[doc]** The dynamic-variables webhook fires **once, at the start of a voice call** (not per turn). Default timeout is **1.5s**, configurable up to 10s via `dynamic_variables_webhook_timeout_ms`. **On timeout the call continues silently using builder defaults**, and any unset var is spoken as raw `{{name}}`.
- **[doc]** Variable precedence: SIP headers > webhook > **assistant builder defaults** > unset. So set a builder default for every var: the webhook can then fail without the call breaking.
- **[doc]** Payload includes `call_control_id`, `telnyx_end_user_target` (caller number), `telnyx_end_user_target_verified` (true only for STIR/SHAKEN "A" attestation, so effectively **false for SG mobiles**), and `assistant_id`.
- **[doc]** Node types: `prompt` (default), `speak` (fixed `message`, `{{var}}` allowed), `tool` (runs one shared tool by `shared_tool_id`, no model turn).
- **[doc]** Edges: `llm` (prompt), `expression` (comparison: `==`, `!=`, `>=`), and `default` (allowed only out of speak/tool nodes; speak nodes need exactly one).
- **[doc]** On calls, **expression edges are evaluated before the model turn**, in array order, and the first true one wins. LLM edges fire through a `transition__<edge_id>` tool, so **never write "do not call tools" in a node prompt**, or the edges stop firing.
- **[doc]** `telnyx_last_tool_status_code` holds the HTTP status of the last **tool node** run, so it can drive a deterministic branch.
- **[doc]** An edge's target can be **another assistant** (handoff).
- **[doc]** `instructions_mode: "append"` is the recommended default. "Replace" uses only the node's own text.
- **[doc]** Actors: `env.X.idFromName(name)` returns a stub you call methods on. Storage is `this.ctx.storage.get/put`. Each name runs single-threaded, and writes are flushed before the method returns. Alarms use `ctx.storage.setAlarm` + `alarm()`.
- **[doc]** `encrypted_dynamic_variables` is for per-caller secrets (e.g. an MCP bearer token), which keeps them out of prompts.

## 0b. Phone number: US (+1), decided 19 Nov
SG numbers need regulatory documents. In the README, say so plainly: "fictional SG bank on a +1 number because SG DIDs need KYC approval; in production this is an SG number". Side effect: US callers (Stephen) may arrive with STIR/SHAKEN "A", so `telnyx_end_user_target_verified` may be **true**. That's still not identity (it proves the carrier vouched for the number, not who's holding the phone). Log it, maybe show it, never authenticate on it.

## 1. Security stance (the design rests on this)
- **Caller ID is not identity.** Spoofing is how these scams work, and SG calls won't carry STIR/SHAKEN "A". So the caller number is used only for **non-sensitive routing hints** (language, "this line is locked", "an open case exists"). It never authenticates.
- **No PII before verification.** The webhook returns no name, balance or card digits. The name comes back only from the verify step.
- **Lockout is enforced in the Actor, not the workflow.** The webhook's `account_locked` only affects UX. Even if the webhook times out and the default `false` applies, the verify tool still hits the Actor, and the Actor refuses. This is defence in depth.
- **Guardrails live in base instructions**: never ask for OTP/PIN/password; never ask for a transfer; never confirm customer data before verification; refuse and warn if the caller starts reading an OTP. Every node appends to them, so no node can drop them by accident.

## 2. Components
```
Caller ─PSTN─> Telnyx AI Assistant (EN main) ──handoff──> ZH / MS / TA specialist assistants (same template)
                 │ start of call                    │ tool node            │ MCP tools (per node)
                 ▼                                  ▼                      ▼
        fn: webhook  (/dv)              fn: webhook (/verify)       fn: mcp (/mcp, Streamable HTTP)
            │  KV: flags, scam cache        │                           │  KV: scam cache
            └── CustomerActor (read) ───────┴── CustomerActor (RMW) ────┴── CustomerActor (RMW)  ← "shared actor"
                                                                        └── ScamNumberActor (Could)
All logs are JSON with trace_id = call_control_id.
```
- **[verified 19 Nov] Project shape:** use the umbrella `telnyx.toml` (fetch handler). `[[actors]]` is only valid there, not in `func.toml`. Pin `@telnyx/edge-runtime` and `telnyx` versions: the secret-scanner workaround (dogfooding #9) patches exact SDK strings.
- **Default layout:** two Edge Functions, `merlion-webhook` (routes `/dv`, `/verify`, `/healthz`) and `merlion-mcp` (`/mcp`, `/healthz`), both bound to the same `CustomerActor` namespace.
- **Fallbacks:** if sharing across functions fails (spike 4), merge into one function with three routes. If MCP-on-Edge fails (spike 3), host the MCP server elsewhere (allowed) and have it call the Function over HTTP, so all state still lives on Edge.
- **Customer directory:** a bundled synthetic JSON fixture (phone → customer_id, preferred_language, DOB, card last-4). This is plain function logic. *Q&A line: in production this is the core-banking API behind the same interface; KV isn't a database replacement.*

## 3. Main (EN) workflow
Base instructions (shared by every node): persona, voice style (short sentences, one question at a time, read digits one by one, confirm numbers back), guardrails from §1.

| # | Node | Type | Mode | Tools | Purpose |
|---|---|---|---|---|---|
| 1 | `entry_router` | prompt | **replace** (tiny: "Say 'One moment please.' only") | none | Deterministic routing before anyone speaks |
| 2 | `otp_disclosure` | **speak** | – | – | Verbatim: recording notice + "Merlion Bank will never ask for your OTP, PIN or password, or ask you to move money to a safe account." |
| 3 | `surge_gate` | prompt | append | none | KV feature-flag branch |
| 4 | `surge_notice` | **speak** | – | – | `{{surge_message}}` (text comes from KV, editable without a redeploy) |
| 5 | `triage` | prompt | append | none | "What happened?" Classify intent |
| 6 | `scam_check` | prompt | append | `check_scam_indicator`, `report_scam_contact` | Unverified help: is this number/link/SMS a scam? |
| 7 | `verify_collect` | prompt | append | none | Collect DOB + card last-4. Refuse OTP |
| 8 | `verify_tool` | **tool** | – | shared webhook tool → `/verify` | Actor RMW: attempt count / lockout |
| 9 | `secure_actions` | prompt | append | `freeze_card`, `open_fraud_case`, `get_case_status` | Verified actions. Confirm before freezing |
| 10 | `police_advice` | **speak** | – | – | Verbatim: make a police report; ScamShield Helpline 1799 *(verify the number before shipping)* |
| 11 | `locked_notice` | **speak** | – | – | "Phone verification is locked until {{lockout_until}}. Please visit a branch with your NRIC." |
| 12 | `escalate` | tool (transfer) | – | transfer → your mobile (demo "fraud desk") | Human handoff |
| 13 | `escalate_failed` | **speak** | – | – | Fallback if the transfer fails: "A specialist will call you back. Your reference is…" |
| 14 | `goodbye` / hangup | speak → hangup tool | – | – | Clean end |

**Edges** (array order matters, since the first true expression wins):
- `entry_router` (expression only, so no model turn is needed):
  1. `account_locked == "true"` → `locked_notice`
  2. `preferred_language == "zh"` → **ZH assistant**; `"ms"` → **MS**; `"ta"` → **TA**
  3. `preferred_language == "en"` → `otp_disclosure`. The builder default is `en`, so unknown callers and a failed webhook both land here.
  4. llm fallback "the caller has said anything" → `otp_disclosure` (safety net for unexpected values)
- `otp_disclosure` default → `surge_gate`
- `surge_gate`: expression `scam_surge_alert == "true"` → `surge_notice`; `scam_surge_alert == "false"` → `triage`. `surge_notice` default → `triage`.
- `triage`:
  1. expression `telnyx_conversation_duration_secs >= 300` → `escalate` (put this first on **every** prompt node)
  2. llm "caller has already transferred money, or shared OTP/PIN/card details/login" → `verify_collect`
  3. llm "caller asks about an existing case or report" → `verify_collect`
  4. llm "caller received a suspicious call/SMS/link but has not lost money" → `scam_check`
  5. llm "caller asks for a human" → `escalate`
  6. llm "caller is speaking, or asks for, Mandarin / Malay / Tamil" → that assistant
- `verify_collect`: llm "both DOB and last-4 collected and read back" → `verify_tool`; llm "caller refuses or can't" → `escalate`; language-switch llm edges as above.
- `verify_tool`: expression `telnyx_last_tool_status_code == "200"` → `secure_actions`; `== "401"` → `verify_collect` (retry; the Actor counts); `== "423"` → `locked_notice`; **default** → `escalate` (tool error, or Actor/Function down).
- `scam_check`: llm "caller reveals money lost / credentials shared" → `verify_collect`; llm "caller is satisfied" → `police_advice`.
- `secure_actions`: llm "card frozen and case opened, case number read out" → `police_advice`; llm "wants a human" → `escalate`.
- `police_advice` default → `goodbye`. `locked_notice` default → `goodbye`. `escalate` default (transfer failed) → `escalate_failed` → `goodbye`.

**Append vs replace, as I'd explain it:** append everywhere, because the guardrails live in base instructions and replace would drop them. `entry_router` is the one deliberate exception. It should never really talk (expression edges fire before the model turn), so its replace text is one line and restates "never ask for OTP" anyway. Q&A answer: "I used replace exactly once, and I know why it's dangerous."

**Why each routing decision uses which edge type:** variable comparisons for anything **safety- or state-critical** (locked, verified, lockout, language from profile, 5-minute timeout, flag). LLM conditions only for **interpreting free speech** (intent, "wants a human", language detection). A model never decides whether someone is verified.

## 4. Language specialists (ZH / MS / TA)
- One template is rendered ×3 by a script calling the Assistants API (config-as-code, checked into the repo). Per language it sets the voice, transcription language, instructions in that language, and translated speak-node text.
- Each specialist's workflow is the main one minus the language edges, plus a "caller wants English" → EN main edge.
- Each one starts at its own native `otp_disclosure`, so a ZH-preferring caller never hears English first.
- A `lang_<code>_enabled` **KV flag** is folded into the webhook: if `lang_ta_enabled=false`, the webhook returns `preferred_language=en`. That gives a **kill switch for a bad language without a redeploy** (useful if Tamil speech recognition is poor on demo day).
- **[spike]** Does a handoff carry the dynamic vars and conversation context, or does the specialist re-fire `/dv`? Either works if `/dv` is idempotent (it is: it only reads).

## 5. MCP server: 5 tools, scoped per node
| Tool | Node(s) | Backing | Notes |
|---|---|---|---|
| `check_scam_indicator(kind: phone\|url\|sms_text, value)` | `scam_check` | KV cache (`scam:phone:<e164>`, TTL) in front of a simulated threat feed (fixture), with simple heuristics for SMS text | Returns `{verdict, reason, source, cached}` |
| `report_scam_contact(kind, value)` | `scam_check` | **Could:** `ScamNumberActor` per number does an RMW report count; at ≥3 reports it writes `scam:phone:*` to KV | Actor is the source of truth for writes, KV is the read cache. Good Q&A material |
| `freeze_card(customer_id, card_last4, reason)` | `secure_actions` | `CustomerActor.freezeCard` (idempotent) | Only works if the Actor shows verified within this call (`verified_call_id == call_control_id`) |
| `open_fraud_case(customer_id, category, amount_sgd?, summary)` | `secure_actions` | `CustomerActor.openCase`: RMW `case_seq++`, case id `MB-<cust>-<seq>` | Idempotent per call (same call → same case) |
| `get_case_status(customer_id)` | `secure_actions` | `CustomerActor.getCases` | |

- **Why the MCP tools check verification server-side:** the model chooses which tools to call, so the server enforces the rules itself.
- **Scoping:** `triage` and `verify_collect` get **zero** MCP tools. Only its transition tools, so the model can't take an action before verification.
- **[VERIFIED ON CALLS, 19 Nov, supersedes the next bullet] Verify flow:** **don't use a tool node** (it skipped the HTTP call in 4 of 5 calls, dogfooding #14/#15). `verify_collect` gets the `verify` webhook tool, called by the model after read-back + "yes". `/verify` **always returns HTTP 200** with `{"verification_status":"verified|failed|locked","first_name":…,"lockout_until":…}`; `store_fields_as_variables` copies these into vars. **Expression edges on `verification_status`**: `verified` → `secure_actions`, `locked` → `locked_notice`. There is **no edge for `failed`**: the caller stays in `verify_collect`, the model says it didn't match and asks again, and the Actor counts attempts and returns `locked` on the 3rd failure. (A `failed` edge would re-fire on the stale variable at the next turn and loop.) Non-2xx = real fault, so there's an LLM edge "verify tool errored" → `escalate`. Server-side fields via `preset_body_fields` (`call_control_id`, `caller`).
- **[superseded] Verify flow:** `verify_collect` has an `update_dynamic_variables` tool (`save_verify_inputs` → `dob`, `last4`). An **expression edge** (`dob != "" and last4 != ""`) moves to the `verify_tool` tool node, which fills `dob`/`last4` from the dynamic vars by name. The webhook tool adds `preset_body_fields` `{call_control_id, caller}` (LLM can't see or alter them, giving the trace ID + customer lookup), and `store_fields_as_variables` writes `verification_status` / `first_name` into vars. Branch on `telnyx_last_tool_status_code` or on `verification_status`. **Every API-created prompt node must set `instructions_mode: "append"` (the API default is replace).** Clear `dob`/`last4` on a 401 retry so the expression edge doesn't loop.
- **Verify is a webhook tool on a tool node, not an MCP tool.** That's what makes `telnyx_last_tool_status_code` usable for a deterministic branch. **[spike]** How does a tool node get its arguments (DOB, last-4)? If it can't take values from the conversation, the fallback is to put `verify_identity` as an MCP tool on `verify_collect` and route with llm edges keyed on a literal result string (`VERIFIED` / `FAILED` / `LOCKED`). Document that as a trade-off.

## 6. State placement (the core "why")
| State | Where | Why |
|---|---|---|
| Verification attempts, lockout_until, verified_call_id | **CustomerActor** (key = customer_id) | RMW under concurrency. Two simultaneous calls from a spoofed number must not both get attempt #3. Single-threaded per customer = a lock without a lock. **Alarm (Could)** clears the lockout at expiry |
| Card frozen flag, cases, case_seq | **CustomerActor** | Same entity, same RMW (sequence numbers). Strongly consistent reads for the "existing case" path |
| Per-number scam report count | **ScamNumberActor** (Could) | Counter RMW. KV increments would lose updates |
| Feature flags: `scam_surge_alert`, `surge_message`, `lang_*_enabled` | **KV** | Read-heavy, written rarely by an operator, eventual consistency is fine. Toggle without a redeploy |
| Known-scam lookup cache | **KV** (TTL) | Classic cache, so a missed write is harmless |
| Customer directory | **Plain function logic** (bundled fixture) | Reference data, not edge state. In production it's an upstream API |
| Language mapping, request validation, signature check, trace id | **Plain function logic** | Stateless |
| In-call progress (which node, what was said) | **The assistant/workflow itself** | Don't duplicate it |
| Metrics counters | **Logs + platform metrics**, not KV/Actor | A KV counter loses updates. A per-call Actor counter would be shoehorned in |

## 7. Observability
- **Log schema** (one JSON line per hop): `ts, level, svc (webhook|mcp|actor), route|tool, trace_id (=call_control_id), assistant_id, caller (masked +65****1234), customer_id, outcome (ok|miss|locked|denied|error|fallback), status, duration_ms, kv_hit, actor_ms, err`. Never log DOB, last-4 or full numbers (PDPA).
- **Trace:** `/dv` gets `call_control_id` in the payload. For `/verify` and MCP, pass it as a header or query using `{{call_control_id}}` in the tool and MCP server config **[spike: is templating supported in MCP URL/headers?]**. Actor methods take `traceId` and log it. Demo: `grep <call_control_id>` shows the call's path through every hop.
- **Signal beyond logs [doc, verified]:** `telnyx-edge metrics <fn>` gives the request count, 2xx/4xx/5xx rates, **p50/p95/p99/avg latency**, CPU and memory (`--since 6h`, `--errors`, `--json`; API `GET /v2/compute/funcs/{id}/metric_aggregates`). Track **webhook p95/p99 against the 1.5s `/dv` budget** and the 5xx rate. Platform invocation logs (`telnyx-edge logs <fn> --type invocations`) record path, status and duration for **every** request, even ones where the code crashed before logging. Plus app counters by `outcome`, derived from logs.
- **Live demo surface:** `telnyx-edge logs merlion-webhook --tail --json | jq` and the same for `merlion-mcp` in a split terminal; `telnyx-edge metrics` afterwards. One-shot reads are capped at 24h / 250 lines, so **export evidence to files as you go** (`--since 24h --last 250 --json > evidence/…`).
- **No alerting is documented.** The README answer for "broken within a minute" is a 60s synthetic probe (external scheduler) + a script polling `metric_aggregates` for 5xx/p95 thresholds. Optional: push custom events to your own sink with a `[[secrets]]` key, off the critical path.
- Extra: set `X-Trace-Id` and `Server-Timing` response headers.
- **"Broken within a minute":** the worst failure is **silent**. The webhook times out and the call carries on with defaults: everyone gets English, nobody sees lockouts, and it sounds fine. Detection:
  - (1) Watch the `outcome=fallback` rate and the `/dv` p95.
  - (2) A **synthetic probe every 60s** hits `/healthz?deep=1` on both functions (KV read + Actor ping + MCP `tools/list`). Run it from somewhere external.
  - (3) Spot-check a call's transcript for a spoken raw `{{`.
  - Look first at the latest `/dv` log lines for that trace_id and their `duration_ms`.
- **Debugging story:** capture evidence the moment something breaks (log line, transcript, screenshot, before/after). Likely candidates: the webhook timing out on cold start, a raw `{{var}}` spoken aloud, an LLM edge not firing, or the tool-node status code type (`"200"` vs `200`).

## 8. Error and fallback paths
| Failure | What the caller experiences | Mechanism |
|---|---|---|
| `/dv` slow or down | Normal English flow | Builder defaults (`preferred_language=en`, `account_locked=false`, `scam_surge_alert=false`); Actor still enforces lockout. Raise timeout to ~3000ms |
| `/verify` errors | "Let me connect you to a specialist" | `verify_tool` default edge → `escalate` |
| MCP tool error | The model apologises; offers a human | Tool returns a structured error plus a `retryable` hint; instructions say "after one failure, offer a transfer" |
| Wrong DOB/last-4 ×3 | Locked notice, then end of call | Actor returns 423 → `locked_notice` |
| Caller reads out an OTP | Interrupted, warned, not stored | Base guardrail + negative test |
| Call runs past 5 min | Transferred | Duration expression edge |
| Transfer fails / no answer | Callback message + reference | Transfer node default → `escalate_failed` |
| Bad language STT on demo day | English | `lang_*_enabled` KV kill switch |
| Unsigned/forged webhook | 401, logged | Verify the Telnyx signature on `/dv` and `/verify` |

## 9. Models
- **Voice path (assistant LLM): a non-thinking, fast instruct model.** Thinking tokens add latency before the first word, and LLM edges depend on prompt tool-calling (`transition__*`). Shortlist from the assistant's model dropdown, test each on 3 calls, and pick on: time to first audio, reliable transition calls, and tool-argument accuracy. Use the no-thinking variant if a model offers both. For ZH, try a Qwen/Kimi-family model; check MS/TA quality per specialist (each specialist can use a different model, which is itself a multi-assistant talking point).
- **Coding (OpenCode):** Kimi-K3 **thinking** as primary (latency doesn't matter; quality does), GLM-5.x as a second opinion or fallback. Note for the dogfooding log: the plugin strips `maxOutputTokens` when tools are present, and K3 used up `max_tokens: 30` entirely on reasoning. That same finding is why the voice path avoids thinking models.

## 10. Spikes to run tonight (each decides part of the design)
1. MCP Streamable HTTP served from an Edge Function, and the assistant lists its tools → §2 layout.
2. One actor namespace bound in two functions → shared actor vs a single function.
3. Tool node argument passing + `telnyx_last_tool_status_code` type on calls → §5 verify design.
4. Expression edges on `entry_router` fire with zero caller speech → §3 entry.
5. `{{call_control_id}}` templating in MCP / webhook-tool config → §7 tracing.
6. Handoff to another assistant: does context/vars carry over? → §4.
7. zh / ms / ta speech recognition + voice quality → which specialists ship.

---

## 11. Build contracts (v1, 19 Nov). Hand these to OpenCode.
**Scope change (19 Nov):** extra languages are **deferred**. `preferred_language` stays as a variable (always `en` for now) so the routing slot exists, but there are no specialist assistants and no spike 6/7 for now.

### Project layout
```
merlion/                    # umbrella telnyx.toml project(s)
  webhook/  → fn merlion-webhook: /dv, /verify, /healthz   (owns CustomerActor class)
  mcp/      → fn merlion-mcp:     /mcp, /healthz           (REFERENCE binding to CustomerActor, no class shipped: verified in spike 2b, small bundle, no scanner patch)
  shared/   → fixtures (customers.json), log.ts, phone.ts, types
assistant/  → assistant.json + tools/*.json + deploy script (config-as-code via Assistants API)
```
Pin exact dependency versions. Keep the secret-scanner patch (dogfooding #9).

### Synthetic customers (`shared/customers.json`, plain function logic)
`{customer_id, first_name, mobile_e164, dob (YYYY-MM-DD), card_last4, preferred_language}`. 3–4 personas, e.g. a normal customer, one with an open case seeded, and one for the lockout demo. **C001 `mobile_e164` = `+6582925458` (the owner's mobile, OK to publish)**, so a real call from you is "known". Testers (Stephen) are unknown callers: they say a persona's registered mobile number (listed in the README).

### Identity rule
Customer = (caller ID match **or** spoken registered mobile) **and** DOB **and** card last-4. Caller ID alone never authenticates. Web-dialer callers arrive as `xxx@sip.telnyx.eu`, so normalise to E.164 or treat them as unknown.

### `POST /dv` (dynamic variables webhook)
- Verify `telnyx-signature-ed25519` + `telnyx-timestamp` (reject if older than 5 min). In dev, allow a bypass flag in KV, never in the demo.
- Look up the caller in the fixtures. If known, read the summary from `CustomerActor(customer_id)`. Read flags from KV.
- **Total budget: ~2500 ms internal, assistant timeout 3000 ms** (KV gets take ~0.9 s, see dogfooding #18; was 500 ms). Any dependency error → return safe defaults, log `outcome=fallback`, still 200.**
- Response (all values **strings**, so expression edges compare consistently):
```json
{"dynamic_variables":{
  "preferred_language":"en","caller_known":"true|false",
  "account_locked":"true|false","lockout_until":"3:45 PM",
  "has_open_case":"true|false",
  "scam_surge_alert":"true|false","surge_message":"…"}}
```
- No name, DOB, card or balance before verification.

### `POST /verify` (webhook tool, model-called)
- Body from the model: `{mobile?, dob, last4}`. Preset by the platform (invisible to the LLM): `{call_control_id, caller}`.
- The function resolves the customer (spoken mobile, else caller), computes `match` against the fixtures, then calls `CustomerActor.attemptVerify({match, callControlId, traceId})`.
- **Always HTTP 200** for business outcomes:
```json
{"verification_status":"verified|failed|locked|not_found",
 "customer_id":"C001","first_name":"Wei Ling",
 "attempts_remaining":"2","lockout_until":"3:45 PM"}
```
- Non-2xx only for real faults (bad signature 401, internal 5xx).
- Tool `store_fields_as_variables`: `verification_status`, `customer_id`, `first_name`, `attempts_remaining`, `lockout_until`.

### `CustomerActor` (key = customer_id). The single-threaded RMW owner
State: `attempts`, `lockout_until`, `verified_call_id`, `card_frozen`, `cases[]`, `case_seq`.
- `getSummary(traceId)` → `{locked, lockout_until, has_open_case, card_frozen}` (lockout expiry checked lazily on read).
- `attemptVerify({match, callControlId, traceId})`: if locked → `locked` (even when `match` is true). If match → reset attempts, set `verified_call_id = callControlId` → `verified`. Else `attempts++`; at 3 → set `lockout_until = now + LOCKOUT_MIN` → `locked`, otherwise `failed`. The Actor never sees DOB/card values, only `match`.
- Phase 2 (MCP): `freezeCard({callControlId, reason})`, `openCase({callControlId, category, amount_sgd, summary})` (`case_seq++`, id `MB-<cust>-<seq>`, idempotent per call), `getCases()`. **Each mutating method rejects unless `verified_call_id == callControlId`.** So the model can pass any `customer_id`, and the Actor refuses unless that customer was verified on this exact call.
- Could: alarm at `lockout_until` to clear the lockout eagerly.

### KV (namespace `MERLION_KV`, keys use `/`: colons are rejected)
- `flag/scam_surge_alert` = `true|false`, `flag/surge_message` = text, `cfg/lockout_minutes` = `15`
- `scam/<kind>/<value>` → JSON verdict, TTL 24 h (phase 2, MCP cache)

### Logging (`shared/log.ts`): one JSON line per request/hop
`{ts, level, svc, route|tool, trace_id (=call_control_id), conversation_id, caller_masked, customer_id, outcome, status, duration_ms, kv_ms, actor_ms, err}`. Mask phones (`+65****4567`). Never log DOB/last4/full numbers. Set `X-Trace-Id` + `Server-Timing` response headers.

---

## 12. Final workflow v1 (supersedes §3 where they differ). Built from spike evidence
Assistant `merlion-fraud-line`. Model `zai-org/GLM-5.3-Flash` (Telnyx-hosted, assistant-recommended, worked in spikes; compare `moonshotai/Kimi-K2.6` later). `greeting: ""` (the start speak node does the greeting). `dynamic_variables_webhook_timeout_ms: 3000`. Builder defaults for **every** variable (all strings): `preferred_language=en, caller_known=false, account_locked=false, lockout_until="", has_open_case=false, scam_surge_alert=false, surge_message="", verification_status="", customer_id="", first_name="", attempts_remaining="", mcp_unused=""`. **Every prompt node has `instructions_mode: "append"` set explicitly** (the API default is replace).

Base instructions: persona (calm Merlion Bank fraud specialist, Singapore English), voice style (short sentences, one question at a time, read digits one by one, never read raw JSON or variable names), guardrails (never ask for or accept OTP/PIN/password/full card number; if the caller starts reading one, interrupt and warn; never tell anyone to move money; no customer details before `verification_status` is verified; never claim an action happened unless a tool result says so).

| id | type | content / instructions | tools |
|---|---|---|---|
| `welcome` (start) | speak | "Thank you for calling Merlion Bank's scam and fraud line." | – |
| `locked_notice` | speak | "For your security, phone verification on this account is locked until {{lockout_until}}. Please visit any Merlion Bank branch with your NRIC, or call back after that time. If you are in danger of losing money right now, call the ScamShield Helpline on 1799." | – |
| `otp_disclosure` | speak | "This call is recorded. Merlion Bank will never ask for your one-time password, PIN or internet banking password, and will never ask you to transfer money to a safe account. If anyone has, it is a scam." | – |
| `surge_notice` | speak | "{{surge_message}}" | – |
| `triage` | prompt | Ask what happened in one open question; classify. | none |
| `scam_check` | prompt | Help check a number / link / SMS with `check_scam_indicator`; give advice. Never verify here. | MCP `check_scam_indicator` |
| `verify_collect` | prompt | If `caller_known` is false, ask for the registered mobile. Ask DOB and last 4 card digits; read them back; on "yes" call `verify`. If the result is failed, say it didn't match and ask again (`attempts_remaining` left). | shared webhook tool `verify` (`tools_mode: append`) |
| `secure_actions` | prompt | Greet `{{first_name}}`. Confirm before acting: freeze the card, open a fraud case, or read the case status. Read the case ID digit by digit. | MCP `freeze_card`, `open_fraud_case`, `get_case_status` |
| `police_advice` | speak | "Please also make a police report online at police.gov.sg/i-witness, or at any neighbourhood police centre. For scam advice, call the ScamShield Helpline on 1799. Do not reply to the scammer." *(verify the URL)* | – |
| `escalate` | prompt | "Tell the caller you're connecting them to a fraud specialist now, then use the transfer tool." | shared transfer tool → +6582925458 (demo fraud desk) |
| `escalate_failed` | speak | "I'm sorry, our specialists are busy. Your details are recorded and a specialist will call you back. If you're losing money right now, call the ScamShield Helpline on 1799." | – |
| `goodbye` | speak | "Thank you for calling Merlion Bank. Stay safe." | – |
| `bye` | tool | hangup | shared hangup tool |

Edges (expression edges are evaluated before the model turn; on speak nodes they're evaluated on arrival):
- `welcome`: expr `account_locked == "true"` → `locked_notice`; **default** → `otp_disclosure`
- `locked_notice`: default → `bye`
- `otp_disclosure`: expr `scam_surge_alert == "true"` → `surge_notice`; default → `triage`
- `surge_notice`: default → `triage`
- `triage`: expr `telnyx_conversation_duration_secs >= 300` (number literal) → `escalate`; llm "caller says money has already been transferred, or they shared an OTP, PIN, password or card details" → `verify_collect`; llm "caller asks about an existing fraud case or report" → `verify_collect`; llm "caller received a suspicious call, SMS, link or app request but has not lost money or shared credentials" → `scam_check`; llm "caller asks for a human or specialist" → `escalate`
- `scam_check`: duration expr → `escalate`; llm "caller reveals they lost money or shared credentials" → `verify_collect`; llm "the caller's question is answered and they have nothing more to check" → `police_advice`; llm human → `escalate`
- `verify_collect`: duration expr → `escalate`; expr `verification_status == "verified"` → `secure_actions`; expr `verification_status == "locked"` → `locked_notice`; llm "the verify tool returned an error or failed to respond" → `escalate`; llm "caller refuses or cannot provide the details" → `escalate`; llm human → `escalate`. **No edge for `failed`.**
- `secure_actions`: duration expr → `escalate`; llm "the requested actions are done and the case number has been read out" → `police_advice`; llm human → `escalate`
- `police_advice`: default → `goodbye`. `goodbye`: default → `bye`.
- `escalate` (prompt; the transfer tool is called by the model): llm "the transfer failed or no one answered" → `escalate_failed`. `escalate_failed`: default → `bye`.

Unknowns to check during phase 3 testing: does `tools_mode: replace` on a node hide MCP tools (for scoping)? Does `has_open_case` need its own path (currently only reflected in triage instructions)? Transfer `from` = the +1 Telnyx number.
