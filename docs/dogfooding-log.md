# Dogfooding log

> Entries compiled with Claude Code (planning/review aid) from the evidence files and OpenCode's build reports. All solution code was written in OpenCode with Telnyx Inference.

Each entry: what broke or surprised me, how I found out, and what I did. Newest entries at the bottom. Evidence (request IDs, log lines, exact error text) goes inline.

Environment: macOS 27.2 on Apple M4 Max (arm64) · OpenCode 1.19.6 · @telnyx/opencode 0.1.5 · telnyx-edge v0.6.0

---

## 1. Promo codes rejected (setup)
- **What:** `FDECHALLENGE112026` and `TELNYXFDE2026` both fail: "This promo code can't be redeemed. Please proceed to payment." Request ID `93719bce-0580-4cf7-8b1a-d6ce3b0fdb0d`.
- **Found by:** the Portal billing page.
- **Did:** emailed Stephen. **Resolved:** $50 credit added by the Telnyx team (balance $55).

## 2. OpenCode installer ships v2; the Telnyx plugin is v1-only
- **What:** `curl -fsSL https://opencode.ai/v2/install | bash` installs OpenCode v2. Loading @telnyx/opencode 0.1.5 fails: `Plugin must export a default definition with an id and an effect or setup function`.
- **Found by:** the plugin load error, then the v2 migration guide. Plugin API moved to `Plugin.define({ id, setup(ctx) })`, auth moved to integrations, and providers split into `ctx.provider.transform` and `ctx.model.transform`.
- **Did:** backed up config, uninstalled v2, installed v1 (1.19.6), and set `"autoupdate": false`. Flagged to Stephen. Possible upstream PR: dual v1/v2 export.

## 3. "Kimi-K3 not found" surfaced as a generic UnknownError
- **What:** `opencode run --model telnyx/moonshotai/Kimi-K3` printed only `UnknownError ... Check server logs`.
- **Found by:** `opencode run --print-logs --log-level DEBUG`, which shows `ProviderModelNotFoundError: Model not found: telnyx/moonshotai/Kimi-K3. Did you mean: moonshotai/Kimi-K2.6?`. Plugin source (team-telnyx/ai, plugins/opencode): v0.1.5 enables only 5 default models via `~/.config/opencode/telnyx-models.json`, and registers only Telnyx-owned text-generation models.
- **Did:** added Kimi-K3 to the allowlist (re-running `opencode auth login`, then "All hosted Telnyx models", also works). **Resolved:** Kimi-K3 works. Possible upstream PR: refresh the default model list.

## 4. Thinking tokens consume the whole output budget
- **What:** a direct `POST https://api.telnyx.com/v2/ai/chat/completions` with Kimi-K3 and `max_tokens: 30` returned `content: null`, `finish_reason: "length"`. All 30 tokens went to `reasoning_content`.
- **Found by:** a raw API call, to separate account/key/model problems from OpenCode problems. This proved the account and key were fine, so #3 was a plugin model-list issue.
- **Did:** design input. The voice path uses a non-thinking model (latency + output budget); coding uses K3 thinking. Note: the plugin strips `maxOutputTokens` because Telnyx rejects `tools` combined with `max_tokens`/`max_completion_tokens`.

## 5. `/telnyx` TUI command doesn't appear
- **What:** `/telnyx` shows "no matching items", even with the plugin listed in `~/.opencode/opencode.json`, `~/.opencode/tui.json` and `~/.config/opencode/tui.json`.
- **Found by:** the TUI command palette.
- **Did:** worked around it by editing `telnyx-models.json` directly. **Unresolved.** Next: grep the newest file in `~/.local/share/opencode/log/` for TUI plugin errors.

## 6. Edge CLI install command in the brief returns 404
- **What:** `https://github.com/team-telnyx/edge-compute/releases/latest/download/telnyx-edge-linux-amd64.tar.gz` returns **HTTP 404** (checked 19 Nov). Release assets are now versioned, e.g. `telnyx-edge-v0.6.0-macos-arm64.tar.gz`, so the unversioned "latest/download" URL no longer resolves. macOS archives are named `macos-*`, not `darwin-*`.
- **Found by:** `curl -sIL -o /dev/null -w '%{http_code}'` on the brief's URL, then the GitHub releases API asset list.
- **Did:** installed v0.6.0 macos-arm64 to `~/.local/bin` after verifying it against `telnyx-edge-v0.6.0-SHA256SUMS`.

## 7. `new-func` usage differs from the brief
- **What:** `telnyx-edge new-func my-webhook -l typescript` fails twice: `❌ --name is required when not using --from-dir`, then `❌ Unsupported language: 'typescript' is not a supported runtime` (valid: `go js ts python quarkus`).
- **Found by:** OpenCode (Kimi-K3) running the brief's command verbatim.
- **Did:** `telnyx-edge new-func --name spike-fn -l ts`.

## 8. Plain `func.toml` scaffold can't hold actors
- **What:** `new-func -l ts` emits a Node `http.createServer` project with `func.toml`. The KV/actor docs assume a fetch-handler + umbrella `telnyx.toml` shape, and `[[actors]]` is umbrella-only per the bindings doc.
- **Found by:** OpenCode, cross-reading the bindings doc against the scaffold.
- **Did:** converted to `telnyx.toml` (kept the same `func_id`) with `[[actors]]` + `[storage.kv.SPIKE_KV]`. `telnyx-edge types` generated `env.COUNTER: ActorNamespace<Counter>` and `env.SPIKE_KV: KvNamespace`.

## 9. Ship-time secret scanner rejects Telnyx's own SDK doc comments ⭐ (debugging-story candidate)
- **What:** `shipping failed: API error (HTTP 422): the upload contains what looks like a secret; move it to a secret binding and ship again: index.ts:62985 (generic-api-key)`.
- **Found by:** the line number in the bundled output pointed into the `telnyx` Node SDK, not my code. Chain: `@telnyx/edge-runtime` 0.16.1 has no `sideEffects: false`, and the root export (`dist/public.js`) is the only entry that exposes `StatefulActor`. The barrel pulls in `build-env.js`, which imports `telnyx` (and `@aws-sdk/client-s3`), so every bundle is ~4 MB. JSDoc `@example` values in the SDK (e.g. `token_group_id: '182bd5e5-…'` in `resources/llm-token-gateway/usage.mjs`) match the scanner's `generic-api-key` rule. The scanner's advice ("move it to a secret binding") doesn't apply: it's vendor comment text. None of the docs mention the scanner.
- **Did:** spike workaround: `scripts/patch-deps.mjs` (postinstall) rewrites 6 doc-example strings in `node_modules/telnyx/resources/**`. Brittle, because it breaks if the SDK version moves, so deps must be pinned. Upstream fix: `sideEffects: false` and/or a narrow `@telnyx/edge-runtime/actors` subpath export. Report to Stephen.

## 10. `telnyx-edge types` needs the entry file to exist first
- **What:** `❌ Entry point not found: main "src/index.ts" does not exist`.
- **Did:** write a stub `src/index.ts`, then generate types.

## 11. Runtime log level shows `[unknown]`
- **What:** every `console.log` line shows level `[unknown]` in `telnyx-edge logs` (the help text admits level detection is often wrong).
- **Did:** rely on the JSON payload's own `level` field, not the platform level.

## 12. MCP SDK runs on Edge unmodified
- **What (positive):** `@modelcontextprotocol/sdk@1.32.2` `WebStandardStreamableHTTPServerTransport` bundles and runs on the Edge runtime (stateless: `sessionIdGenerator: undefined`, `enableJsonResponse: true`, a new server + transport per request). `node:*` imports are confined to stdio/SSE modules, which never get bundled. `initialize` → 200, `notifications/initialized` → 202, unknown method → JSON-RPC `-32601`.

## Evidence: Actor vs KV under concurrency (spike 2, single function)
50 parallel increments + 1 read, 2026-11-19T04:51Z, same name (`spikes/evidence/spike2-actor-vs-kv.txt`):
- Actor (`/inc`): **51**, exact.
- KV get→put (`/kvinc`): **3**, so 48 of 51 updates were lost.

## 13. API vs docs differences found while creating assistant A via the API
Source: `telnyx` Node SDK 7.31.0 type definitions (`resources/ai/assistants/assistants.d.ts`, `tools.d.ts`), which are more complete than the docs pages.
- **`instructions_mode` defaults to `replace` in the API**, while the workflow docs call append "the recommended default". Any node created via the API without an explicit `"instructions_mode": "append"` silently drops the base instructions (and the guardrails in them). Set it on every prompt node.
- **Expressions are richer than the docs show:** ops `== != < <= > >= contains not_contains`, `bool_op` (`and`/`or`/`not`), arithmetic, and `bool_literal` (an "always" edge, even on prompt nodes).
- **Tool nodes fill arguments from dynamic variables by name** (a variable named like a tool parameter supplies that argument). Combined with the `update_dynamic_variables` tool type (the model writes vars mid-call), this is how a tool node receives caller input. Answers most of spike 3.
- **Webhook tools:** `preset_body_fields` / `preset_query_params` are mustache-templated and invisible to the LLM (e.g. `{{call_control_id}}` as an untamperable trace ID, or `customer_id` the model can't spoof). `store_fields_as_variables` maps response JSON paths into dynamic vars, so a tool result can drive expression edges.
- **Speak-node unresolved `{{var}}` renders as an empty string** (SDK docstring), whereas the dynamic-variables docs say unset vars stay as raw `{{name}}` text. To confirm on a call.
- **Not every hosted model is allowed on assistants:** `meta-llama/Llama-3.3-70B-Instruct` → `10027 Model ... is not available for AI Assistants`. `GET /v2/ai/models` has `recommended_for_assistants`. Telnyx-hosted, recommended: `moonshotai/Kimi-K2.6` (multilingual), `zai-org/GLM-5.2`, `zai-org/GLM-5.3-Flash`, `nvidia/NVIDIA-NemotronLabs-VoiceChat-11B`. Kimi-K3 is not recommended for assistants.
- MCP server `type` is `"http"`. Telnyx doesn't call `tools/list` when the assistant is created (no `/mcp` hit in invocations); discovery happens at call time.
- Assistant defaults when not specified: voice `Telnyx.Ultra.*`, STT `deepgram/flux` (en), **recording enabled (dual-channel mp3)**. Recording has a disclosure implication: the OTP speak node must mention it. `voice_settings.language_voices` and `transcription.settings.language_hints` exist (relevant for the language specialists).

## 14. Spike results from 3 web test calls on assistant A (19 Nov, 05:18–05:22Z)
Evidence: `spikes/evidence/assistant-a-calls-runtime.json`, `spikes/evidence/conv-*.json` (transcripts via `GET /v2/ai/conversations/{id}/messages`), `spikes/evidence/dv-payload-sample.json`.
- **Spike 5 (trace) PASS:** `{{call_control_id}}` resolves in the MCP server URL (`?trace=v3:…`), webhook-tool headers (`x-trace-id`) and `preset_body_fields` (`trace_id`). The same `v3:` ID is in the `/dv` payload as `call_control_id`. MCP `initialize` also carries `params._meta.telnyx_conversation_id`. Webhook-tool requests arrive with `user-agent: ai_assistants`.
- **`/dv` payload:** `call_control_id`, `call_session_id`, `telnyx_conversation_id`, `from`/`telnyx_end_user_target` (web dialer: `xxxx@sip.telnyx.eu`, not E.164, so handle non-phone callers), `telnyx_end_user_target_verified: false`, `telnyx_call_caller_id_name`. Signed: `telnyx-signature-ed25519` + `telnyx-timestamp` headers on `/dv` and `/verify` (not on MCP).
- **Spike 1 (MCP):** the assistant runs `initialize` → `notifications/initialized` → `tools/list` at call start, and again on entering a node with `tools_mode: append`. `tools/call` not exercised yet.
- **Spike 4 (entry routing) PARTIAL:** expression edges on a **prompt** start node did route to "Route B", but only after a user turn or the idle timeout ("[long silence]" ≈ 10s with an empty greeting). They are evaluated at the next turn, not on node entry. Fix under test: make the start node a **speak** node with expression edges + one default edge (speak nodes auto-advance).
- **Spike 3 (tool node) PARTIAL, looks intermittent:** in all 3 calls the model called `save_verify_inputs` correctly and the expression edge (`and` of three `!= ""`) moved to the tool node ("Checking now." spoken). **401 call:** tool ran, `/verify` got `{dob,last4,force_status}` filled from the dynamic vars plus the preset fields, and `telnyx_last_tool_status_code == "401"` (string) routed to `s401` ✅. **200 and 500 calls:** the tool node **never sent an HTTP request** (no `verify` tool call in the transcript, no `/verify` invocation), and the flow went straight to the default branch. The user's first impression was "all three ended at default". The transcripts showed otherwise. Hypothesis: a race between the var update and tool-node entry. The default edge is at least fail-safe (it maps to escalate in the real design). Re-testing.
- STT note: "Danita January…" was a mis-transcription of the date of birth. Read numbers back before saving them.
- Tooling note: `telnyx-edge logs --tail --json` wraps app JSON in `.message` (a string). Filter with `jq -c '.message | fromjson? | {route,status,query,body}'`.

## 15. Re-test after changes (19 Nov, 05:24–05:26Z): entry fixed, tool node reproducibly skips
Evidence: `spikes/evidence/conv-a41b4e16-….json`, `conv-ea5a2bca-….json`, `assistant-a-calls-runtime-2.json`.
- **Spike 4 PASS:** with the start node changed to a **speak** node (expression edges + one default), the first assistant message is "One moment. Route B. Language en." with **no user turn and no idle wait**. Design rule: **deterministic entry routing goes on a speak start node, not a prompt node.**
- **Spike 3, tool node: reproduced, 1 of 5 calls worked.** Both new force_status=200 calls show the same sequence: `save_verify_inputs` → `{"updated":[…]}` → "Checking now." (tool-node `message`) → ~230 ms later "Default branch." **No `verify` tool call in the transcript, no `/verify` invocation in the Edge logs.** The one success (force_status 401, conv `75085e79`) shows an explicit `verify` tool call. No timing or wording difference explains it. Root cause unknown (platform side). **This is the main debugging-story candidate:** the symptom ("always default") looked like a status-code type problem, but the transcript plus the invocation logs proved the request was never sent.
- **Decision:** don't depend on tool nodes for verification. Spike-a v3: the `verify` webhook tool is attached to `collect` and called by the model. `store_fields_as_variables` maps the response into `verify_result`, and **expression edges on `verify_result`** route. The model chooses *when* to call verify, but never *what the result is*. The result comes from the server, and routing on it is deterministic. Testing next.

## 16. Model-called webhook + `store_fields_as_variables` (spike-a v3, 19 Nov 05:30–05:35Z)
Evidence: `spikes/evidence/conv-fc19f71a-…` (200), `conv-85fa0212-…` and `conv-2af973ee-…` (401), `conv-4feacf9e-…` (500).
- **200 ✅:** the model called `verify`. The tool result is the **raw response body** (`{"received":{…}}`), so `store_fields_as_variables` set `verify_result="200"` and `echoed_dob`. The expression edge fired, then the `s200` speak node ("Two hundred. Echoed date of birth 1997-01-23."), then hangup.
- **401 / 500 ❌ (but informative):** for non-2xx responses the tool result is **wrapped**: `{"http_status":401,"http_body":{"received":{…}}}`. `received.force_status` doesn't resolve, so **no variable was stored, no expression edge fired, and the model improvised** ("Verification returned status 401 — unauthorized.", "Goodbye."). What sounded like the `s401` speak node during testing was actually the LLM paraphrasing. Only the transcript showed the difference (speak-node text is exact; this wasn't).
- **Design rule:** the verify endpoint returns **HTTP 200 with a business result** (`{"verification_status":"verified|failed|locked", …}`). Non-2xx is reserved for real faults. For real faults (5xx/timeout) no variable gets set, so the node needs an explicit path: instructions ("if verify errors, say you'll connect a specialist") + an LLM edge "the verify tool failed or returned an error" → `escalate`, plus the 300 s duration edge as a backstop.
- Prompt-following notes (GLM-5.3-Flash): it called `verify` *before* reading the values back (the instruction said read back first), and invented "last four digits of your ID". Real prompts need explicit order ("confirm, wait for yes, then call") and exact wording for what's being collected.

## 17. Spike 2b: one Actor type shared by two functions ✅ (19 Nov ~05:44Z)
- `spike-fn` (owner, ships the `Counter` class) and `spike-fn2` (reference, same `[[actors]] binding="COUNTER" type="Counter"`, **no class shipped**). Interleaved `/inc?name=shared-test` across both → 1, 2, 3, 4: one durable counter, two entry points.
- `telnyx-edge actors inspect Counter` lists `spike-fn COUNTER owner` / `spike-fn2 COUNTER reference`. Instances = distinct names ever addressed.
- `telnyx-edge types` handles reference-only bindings explicitly: `env.COUNTER → ActorNamespace (reference-only: Counter is not exported from main)`. You hand-narrow the type. Good UX; matches the Shared Actors doc, which worked verbatim.
- **Side effect that matters:** the reference function's bundle is **2,365 bytes vs ~4 MB**, because type-only imports are erased and the `@telnyx/edge-runtime` barrel never gets bundled. So it **ships without the secret-scanner workaround** (#9). That confirms #9's root cause: the scanner trips only when runtime code from the barrel lands in the bundle.

## 18. Phase 1 (merlion-webhook) findings (19 Nov ~06:30Z)
- **KV key charset:** `❌ API error (HTTP 400): Bad request - Invalid key format. Allowed characters: a-z A-Z 0-9 - _ / = .` Colons aren't allowed, and the KV docs don't say so. Keys are now `flag/…`, `cfg/…`, `scam/<kind>/<value>`.
- **KV read latency ≈ 0.85–0.98 s per `get`, even warm** (`kv_ms` 983 → 851 → 895). Actor calls: ~25 ms warm, ~600 ms cold. Not documented. Consequence: a serial KV read can never fit a sub-second `/dv` budget. The first version fell back on every call. Fix: parallel fetches + in-isolate stale-while-revalidate cache for flags. Warm `/dv` is 30–98 ms; a **cold isolate still falls back** (2.7 s first request measured from SG at 06:38Z).
- **Design consequence:** raise the assistant's `dynamic_variables_webhook_timeout_ms` to 3000 and the function's internal budget to ~2500 ms. The 60 s synthetic probe (`/healthz?deep=1`) doubles as a keep-warm. During the demo, run the probe loop so the first call isn't cold.
- Secret-scanner workaround needed again (owner function ships the actor class, ~2.67 MB bundle). Pinned `telnyx@7.31.0` via npm `overrides` so the patch strings stay valid.
- Worked as documented: `ctx.id` = the `idFromName` name; `this.env` is available inside the actor; `import … with { type: "json" }` and cross-directory imports bundle fine.
- Verified by Claude at 06:38Z: unsigned `/dv` → 401 (`cfg/dev_skip_sig=false`), `/healthz?deep=1` OK, `X-Trace-Id` + `Server-Timing` headers present.

## 19. Phase 2 (merlion-mcp) findings (19 Nov ~07:00Z)
- `CustomerActor` shared across functions: `merlion-webhook` owner + `merlion-mcp` reference. **Re-shipping the owner with new methods was visible to the already-deployed reference on its next request**, with no reference redeploy and no version-skew error. Not documented, and it worked.
- Reference bundle 1.4 MB (MCP SDK only), so it ships without the secret-scanner patch (as in #17).
- `structuredContent` passes through beside `content[].text` (MCP 2025-06-18). One tool result serves both the voice model (a speakable sentence) and machines (fields).
- **KV doesn't buy latency here:** `check_scam_indicator` miss 2248 ms (read ~1 s + write ~1.1 s), hit 1030 ms (just the read). Warm actor calls: 18–63 ms.
- **Possible cause (Claude, from invocation logs):** curl tests from Singapore are served from **`region: me-central-1`** (40 of 44 recent webhook invocations); a few came from `us-east-1/2`. If the KV primary isn't in me-central-1, ~1 s is a cross-region read. **The latency that matters is from the assistant runtime's path.** Re-measure `kv_ms` on real assistant-originated `/dv` and MCP calls before deciding KV's role. Neither `ship`, `new-func` nor `storage` exposes a region option. Question for Stephen.
- MCP tools can't be scoped per node via the API: `FlowNodeReq` has `shared_tool_ids`/`tools_mode` only; MCP servers attach at the assistant level (`mcp_servers[].allowed_tools` is per assistant). Scoping is therefore enforced server-side (Actor `not_verified` gate) and by node instructions. To test: does `tools_mode: "replace"` hide MCP tools on a node?

## 20. Phase 3 (assistant as config-as-code) findings (19 Nov)
- **Update verbs differ per resource:** shared tools → `PATCH /v2/ai/tools/{id}`; MCP servers → **`PUT`** (`PATCH /ai/mcp_servers/{id} -> HTTP 404 … "code":"10005","title":"Resource not found"`: a 404, not a 405, so it looks like a wrong ID); assistants → `POST /v2/ai/assistants/{id}`. The SDK source (`resources/ai/mcp-servers.mjs`) was the tie-breaker.
- Phone number wiring: number → TeXML app (`voice_url …/ai/assistants/<id>/texml`) → assistant.
- GET-back diff of the deployed assistant: 0 changed, 0 dropped. Server adds defaults (`tools_mode: "replace"` on prompt nodes without shared tools, `allowed_tools: null`). `instructions_mode: "append"` preserved on all prompt nodes. Deploy is idempotent (second run: same IDs).
- Local validation before any API call (edge endpoints exist, one default edge per speak/tool node, none on prompt nodes, append everywhere) means workflow-shape errors are caught before they cost a test call.

## 21. First end-to-end test calls on `merlion-fraud-line` (19 Nov 07:30–07:42Z)
Evidence: `evidence/phase3/transcript-*.txt`, `evidence/phase3/merlion-*-runtime.json`.
- ✅ **Scam check path:** speak nodes verbatim, `check_scam_indicator` → "suspicious", then police_advice → goodbye → hangup.
- ✅ **Verify → secure actions (C004):** verified, `open_fraud_case` → MB-C004-1, `freeze_card` → frozen, each confirmed yes/no first.
- ✅ **Lockout (C003):** failed (2 left) → failed (1 left) → `locked` → expression edge → `locked_notice` speak → hangup. Actor RMW observed live.
- ⚠️ **Transfer:** `403 … "code":"10010","detail":"Dialed number is not included in whitelisted countries D13…"`. The outbound voice profile doesn't whitelist SG. **The fallback worked:** LLM edge → `escalate_failed` speak → hangup. Fix: Portal outbound voice profile → allow Singapore.
- **Real-path latency:** `/dv` was served from `us-east-1/2`, `/verify` from `eu-west-1`. KV `kv_ms` was still **763–2724 ms**, so KV is ~1 s from the assistant path as well, not just from SG curl (#19 hypothesis rejected). Caller-facing: `/verify` 0.9–2.5 s, `check_scam_indicator` 2.5 s (KV), MCP actor tools 53–97 ms. **Decision: no KV on mid-call paths.**
- Telnyx signature verification passes on real `/dv` and `/verify` calls.
- Prompt-quality issues (GLM-5.3-Flash): invented "forward it to 7726" (not an SG short code); opened the case before freezing the card; said goodbye itself before the goodbye speak node; "we have 2 attempts remaining".

## 22. Double "I'm sorry to hear that" on LLM transitions + identifier handling (calls 2 and 3)
Evidence: `evidence/phase3/messages-4a4255d3-….json`, `messages-04188ab9-….json` (the full 58/36 messages; `transcript.sh` output had been truncated).
- **Symptom (reported by ear):** after "I transferred money…", the caller hears "I'm sorry to hear that" twice.
- **Cause (from the transcript):** two assistant messages ~250–350 ms apart. In `triage` the model says "I'm sorry to hear that…" **while** calling the `transition__*` tool, and that text is spoken (the edge docs say "the current turn's LLM response is delivered to the user as-is"). Then `verify_collect` starts its own turn and acknowledges again: "I'm sorry to hear that — let's act quickly…". So it's two nodes each doing empathy, not a repeated TTS chunk.
- **Fix:** triage instructions say to route silently or with a neutral bridge ("Let me help you with that."), with no empathy; every post-transition node says "Don't acknowledge or apologise again; the previous step already did. Start with your first question."
- **Identifier handling:** the caller (testing) said "eight zero zero zero zero zero two" (7 digits) and the model **silently sent `+6580000002`** to `/verify`. It "corrected" an identifier the caller never said. Rule: never add, drop or change digits; read back exactly what was heard. The fake persona numbers (`8000000x`) are also hard to say correctly; switch to distinct, speakable numbers.
- In call 2 the model skipped the mobile and called `verify` with only DOB + last-4 from a SIP caller, which returned `not_found` as expected. It then recovered by asking for the mobile again.

## 23. `env.SECRETS.get()` is a ~0.7 s RPC on every call (phase 4, 19 Nov)
- **Symptom:** after moving `dev_skip_sig` off KV into a secret, warm `/verify` still took ~700 ms, with `actor_ms` ~30 and `kv_ms` null.
- **Found by:** reading `@telnyx/edge-runtime/dist/build-env.js`. `SecretsImpl.get()` does `POST {daprUrlRoot}/v1.0/bindings/{binding}` (a sidecar RPC) **on every call**, the same latency class as a KV read. Nothing in the secrets docs mentions the cost.
- **Fix:** read the injected environment variable (`process.env.NAME`, which the bindings doc says secrets are also exposed as), falling back to `SECRETS.get`.
- **Result (warm, same routes):** `/dv` ~700 → **25–29 ms** (cold isolate 991 ms); `/verify` 0.9–2.5 s → **36–46 ms**; `check_scam_indicator` 2.1–2.3 s → **~0 ms** (KV cache removed, bundled feed + heuristics).
- **General lesson:** on this runtime, every binding call except the Actor (KV, secrets) is a sidecar round trip of ~1 s. Keep them off mid-call paths, cache in-isolate, and use the Actor (~30–60 ms warm) for hot state.
- Other phase 4 changes: `/admin/reset` (bearer `ADMIN_TOKEN`, 401 otherwise) + `scripts/reset-demo.sh`; personas moved to speakable numbers; prompt fixes for #21/#22. Deploy diff: 0 changed, 0 dropped.

## 24. Test round 2 (19 Nov 08:22–08:34Z), after phase 4
Evidence: `evidence/round2/messages-*.json`.
- ✅ Scam SMS path, ✅ Daniel freeze-first + case, ✅ the double "sorry" on triage → verify_collect is gone (triage now says only "Let me help you with that.").
- **"More than 3 tries" (Mei Yun, C003): the Actor was right, the model wasn't.** 4 `verify` calls: failed (2 left) → failed (1 left) → **`not_found`** → `locked`. On the 3rd call the model **dropped the `mobile` argument**. A web caller has no phone caller ID, so the server couldn't resolve a customer, returned `not_found`, and no attempt was counted. The caller experienced 4 tries. Fix: `/verify` remembers the customer resolved earlier **in the same call** (keyed by `call_control_id`) when `mobile` is missing; the tool schema/description says to always send the mobile once given.
- **"Thank you, Raj. You are verified." spoken twice:** a different double-speak path, within one node. In `secure_actions` the model emitted text **alongside** the `get_case_status` tool call (spoken immediately), then repeated it after the tool result. Fix: when calling a tool, say at most a short filler ("One moment.") and never repeat it after the result.
- **Transfer reached voicemail:** `transfer` result "Transfer completed". The call was bridged to the mobile's voicemail (likely phone-side screening of an unknown international +1 caller, e.g. iOS "Silence Unknown Callers" or carrier scam filtering). The platform counts voicemail as success, so `escalate_failed` didn't run. Fix: the transfer tool's `voicemail_detection` with `on_voicemail_detected.action = "stop_transfer"`, so voicemail → transfer fails → `escalate_failed`. Plus `warm_transfer_instructions` so the specialist hears context (verified? customer name? what happened?) before the bridge.
- API note: `GET /v2/ai/conversations/{id}/messages?page[size]=200` → `10015 Bad Request` (max page size 100).

## 25. Phase 5 (commit 54c874c)
- `/verify` remembers the customer resolved earlier in the same call (in-isolate map + actor write keyed by `call_control_id`, 30 min staleness). Reason for the actor write: the platform doesn't document isolate affinity between the requests of one voice conversation, so a map alone could lose the customer mid-call. The round-2 repro (mobile omitted on the 3rd attempt, SIP caller) now counts the attempt (`failed`, 2 → 1 left) instead of `not_found`.
- Base prompt: at most "One moment." alongside a tool call; never repeat after the result. Transfer tool: `warm_transfer_instructions` briefs the specialist (verification status, first name, what happened). Voicemail detection deliberately not enabled (assumption: the specialist answers; production would enable `stop_transfer`).
- **Trade-off of moving the signature bypass off KV:** `DEV_SKIP_SIG` is now a deploy-time env var, so flipping it needs `telnyx-edge ship` (unsigned calls kept getting `{"error":"invalid signature"}` 401 until re-ship). That's the intended semantics: an auth bypass shouldn't be a runtime toggle.

## 26. Signature check left OFF in production after phase 5, caught by post-deploy review ⭐ (security story)
- **Found by:** Claude's post-deploy probe at ~08:55Z: unsigned `POST /verify` → **200** with a real verification result (`C004 … attempts_remaining "2"`); unsigned `/dv` → 200. `telnyx-edge secrets list` showed `DEV_SKIP_SIG` last updated **08:51**, the same minute as revision `ed93872c` (OpenCode turned the bypass on for a live repro, shipped, and didn't turn it off). Impact while open: anyone could brute-force or lock out personas via `/verify`.
- **Fix:** `telnyx-edge secrets add DEV_SKIP_SIG false` + re-ship. The first two ships failed: `shipping upload returned API error (HTTP 500): … The Telnyx API server encountered an error … could not be confirmed (no new revision observed)`. The third (`ship -v`) deployed revision `5761aec9` at 09:08Z. Verified: unsigned `/verify` and `/dv` → **401**. Demo state reset afterwards.
- **Guardrail to add:** the deep health check reports `sig_enforced`, and the 60 s probe alerts if it's false. Secrets are injected at deploy time, so a flipped secret without a ship (or a ship without flipping back) is exactly the drift the probe should catch.
- `ship` 500s are transient upload failures with no revision created (`deployments` showed none). Retry with `-v` to see the request flow; `rollback <fn> <revision>` is the instant escape hatch.

---

## Observations (not bugs, but they shaped decisions)
- **Edge CLI v0.6.0 has features the brief doesn't mention:**
  - `actors` (account-scoped StatefulActor types, with `inspect`, `instances`, `logs`, `metrics`). This suggests actors are shared across functions by design, and `actors instances` shows live actor state for the demo.
  - `deployments` (deploy history, including why a deploy failed).
  - `log-export` (push logs to an external sink).
  - `dev` + `telnyx.toml` (umbrella multi-function project).
  - `tunnel`, `types`, `rollback`, `revisions`.
- **Observability docs:** `telnyx-edge metrics <fn>` gives request count, 2xx/4xx/5xx, p50/p95/p99/avg latency, CPU and memory. `telnyx-edge logs <fn> --type invocations` records every request even if the code never logged. Live tail is `--tail --json`. One-shot reads cap at 24h / 250 lines, so evidence has to be exported as you go. No alerting is documented.
- **Docs link rot:** the brief's "Logs & Metrics" link (`/docs/edge-compute/reference/logs-metrics`) returns 404. The current page is `/docs/edge-compute/observability/logs` (+ `/observability/metrics`).
- **Dynamic variables webhook:** fires once, at voice-call start. 1.5s default timeout (max 10s). On failure the call proceeds silently with builder defaults, so a broken webhook doesn't sound broken. That drove the "builder default for every variable" decision and the probe-based alerting.
- **Phone number:** SG DIDs require regulatory documents, so I used a US (+1) number for the fictional SG bank.
