> Spike runbook drafted with Claude Code (Opus). Spike code itself is written in OpenCode with Telnyx Inference.

# Spike runbook (Thu night). Throwaway code, written in OpenCode.

Put it in `~/coolbeans/redbean/spikes/` and save evidence to `spikes/evidence/` (JSON logs, transcript screenshots). Everything in this folder feeds the README dogfooding log and debugging story.

**Economy:** 2 functions + 2 test assistants cover all 7 spikes.
- `spike-fn` (one function, 4 routes): `/dv`, `/verify`, `/mcp`, `/inc`
- `spike-fn2`: binds the same actor namespace (spike 2)
- Assistant **A** (`spike-a`): workflow tests. Assistant **B** (`spike-b`): handoff target + language tests

**Testing calls cheaply:** use the assistant's **Test / web call** in the Portal for most iterations (no international charges). Dial the real +1 number from your SG mobile for checkpoints (spike 4 at least once, plus the end-of-night "real call").

Keep `telnyx-edge logs spike-fn --tail --json` running in a side terminal throughout.

---

## Prompt for OpenCode (Kimi-K3) to build `spike-fn`
> Scaffold with `telnyx-edge new-func spike-fn -l typescript`. Every route logs one JSON line with the route, full request headers, and body. Routes:
> - `POST /dv`: return `{"dynamic_variables":{"route":"b","preferred_language":"en"}}`; log the payload.
> - `POST /verify`: log the body; respond with the HTTP status taken from the `force_status` field in the body or query (default 200).
> - `POST /mcp`: a stateless MCP Streamable HTTP server (JSON responses, no SSE) with one tool `echo(text)`. It returns the text plus the `trace` query param and the request's headers. Try `@modelcontextprotocol/sdk` with its web-standard transport first. If it won't bundle for the Edge runtime, hand-roll JSON-RPC for `initialize`, `notifications/initialized`, `tools/list` and `tools/call`.
> - `GET /inc?name=x`: increments a counter in a StatefulActor `Counter` (via `idFromName`) and returns the new value. `GET /kvinc?name=x`: the same counter in KV (get, then put).
> Configure the KV + actor bindings in `func.toml`.

(Read the Bindings docs page first so you can sanity-check the `func.toml` it produces.)

---

## Spike 1: MCP served from an Edge Function
```bash
U=https://spike-fn-<org>.telnyxcompute.com
H=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
curl -s "${H[@]}" $U/mcp -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
curl -s "${H[@]}" $U/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s "${H[@]}" $U/mcp -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"}}}'
npx @modelcontextprotocol/inspector   # transport: Streamable HTTP, URL $U/mcp
```
Then add the server in Portal → AI Assistants → Integrations / MCP Servers, attach it to assistant A, and tell A to "use the echo tool to say hello".
**Pass:** a `tools/call` appears in the tail during a real assistant conversation.
**Fail:** host MCP elsewhere and have it call the Function over HTTP.

## Spike 5: trace-id templating (run with spike 1)
Set the MCP server URL to `$U/mcp?trace={{call_control_id}}` and, if the UI allows, a header `X-Trace-Id: {{call_control_id}}`. Do the same on the `/verify` webhook tool (header + body field).
**Pass:** the logs show a real `v3:...`-style id, not the literal braces. Compare it with the `call_control_id` that `/dv` logged for the same call.
**Fail:** trace via `/dv` → Actor: store `call_control_id` keyed by caller, then correlate by caller + timestamp window. Document the gap honestly.

## Spike 2: actor shared across functions + concurrency proof
`spike-fn2` binds the same actor namespace and exposes `/inc`.
```bash
curl "$U/inc?name=s"; curl "$U2/inc?name=s"          # expect 1 then 2
seq 50 | xargs -P50 -I{} curl -s "$U/inc?name=race" >/dev/null; curl "$U/inc?name=race"   # expect 51
seq 50 | xargs -P50 -I{} curl -s "$U/kvinc?name=race" >/dev/null; curl "$U/kvinc?name=race" # expect < 51 = lost updates
```
**Pass:** the counter stays continuous across both functions, and the Actor hits exactly 51.
**Save** the Actor vs KV numbers as evidence. That's your "why an Actor" proof in a single slide.
**Fail (sharing):** one function with multiple routes.

## Spike 4: dynamic variables + entry expression edges before speech
Assistant A:
- Dynamic variables webhook = `$U/dv`, timeout 3000ms. Builder defaults `route=a`, `preferred_language=en`.
- Workflow: `entry` (prompt) with expression edges `route == "b"` → speak "You took route B, language {{preferred_language}}", and `route == "a"` → speak "Route A". Each speak node → default → hangup.
Call it and **stay silent**.
**Pass:** you hear "route B" without speaking.
Then make `/dv` return 500 (or sleep 5s). **Pass:** you hear "route A" (builder default) and no raw `{{...}}`.
Save the `/dv` payload from the logs as your real fixture shape. Note which signature headers arrive.

## Spike 3: tool node arguments + status-code branching
In assistant A, add a shared **webhook tool** `verify` → `$U/verify`, with parameters `dob`, `last4` (+ `force_status`).
Workflow: prompt "Ask for a date of birth and 4 digits" → llm edge "both given" → **tool node** `verify` → expression edges `telnyx_last_tool_status_code == "200"` → speak "two hundred", `== "401"` → speak "four oh one", default → speak "default".
Run 3 calls with force_status 200 / 401 / 500.
**Check:** (a) did the body contain the spoken DOB/last4, i.e. how does the tool node fill its args? (b) which speak node played? If "default" played for 200, try the numeric literal `200`.
**Fail on args:** `verify_identity` becomes an MCP tool on the prompt node, routed with llm edges on a result string.

## Spike 6: handoff to another assistant
Assistant B: speak node "This is B. Route is {{route}}." then a prompt node "Repeat back the last thing the caller told the previous assistant."
In A, add an llm edge "caller asks for B" → assistant B.
**Check:** do `{{route}}` (vars) and the conversation carry over? Does `/dv` fire again (look for a second `/dv` log line with B's `assistant_id`)?

## Spike 7: languages
On B (or clones), set the voice + transcription language to zh, then ms, then ta. Speak a scam-report sentence in each and read the transcript in the conversation history.
**Score each 1–3** on transcription accuracy and voice naturalness, plus handling of mid-sentence code-switching (Singlish + Mandarin).
Ship a language only at score ≥2. Note which STT/TTS providers offer ms/ta.

---

## End-of-night checkpoint
- Real PSTN call to the +1 number reaches a 2-node workflow
- Decisions recorded: MCP location, shared actor y/n, verify via tool node vs MCP, trace method, which languages ship
- Evidence files saved

---

## Portal setup: test assistant A (spikes 1, 3, 4, 5 in one assistant)
`B=https://spike-fn-eb9bd597-3.telnyxcompute.com`. UI labels are from the docs and may differ slightly in the Portal.

1. **Create:** AI Assistants → Create → blank. Name `spike-a`. Model: a fast non-thinking one. Base instructions: "You are a test harness. Keep replies under 10 words. Route is {{route}}, language is {{preferred_language}}." Referencing the vars in the instructions makes sure they're registered.
2. **Dynamic variables:** webhook URL `$B/dv`, timeout 3000 ms. Defaults `route = a`, `preferred_language = en`.
3. **MCP server:** Integrations / MCP Servers → add `$B/mcp?trace={{call_control_id}}` (Streamable HTTP). Attach it to spike-a; `echo` should appear.
4. **Webhook tool `verify`:** POST `$B/verify`; body params `dob` (string), `last4` (string), `force_status` (integer); header `X-Trace-Id: {{call_control_id}}`. Tool nodes run **shared** tools (`shared_tool_id`), so if the node can't select an inline tool, create it as a shared tool.
5. **Workflow:**
   - `entry` (prompt, append). Expression edges in this order: `route == "b"` → `speak_b`; `route == "a"` → `speak_a`.
   - `speak_b` "Route B. Language {{preferred_language}}." → default → `collect`
   - `speak_a` "Route A, builder default." → default → `collect`
   - `collect` (prompt, append, echo enabled): "Ask for a date of birth, four digits, and a test status code: 200, 401 or 500. If asked, use the echo tool." LLM edge "caller gave a DOB, four digits and a status code" → `verify_node`.
   - `verify_node` (tool node, `verify`). Expression edges `telnyx_last_tool_status_code == "200"` → `s200`; `== "401"` → `s401`; default → `sdefault`.
   - `s200` / `s401` / `sdefault` speak "two hundred" / "four oh one" / "default" → default → `collect` (loops, so one call covers several tests).
6. **Test:** web test call, with `telnyx-edge logs spike-fn --tail --json | jq -c '{route,status,query,body}'` running in a terminal.

### Observation checklist (write answers into the dogfooding log)
| # | Question | Where to look |
|---|---|---|
| 4 | Did you hear "Route B" **before** speaking? Does an assistant greeting play before `entry`? | Ear + transcript |
| 4 | `/dv` payload shape + signature headers | `/dv` log line → save as fixture |
| 5 | `trace` query and `x-trace-id` header: real ID or literal braces? Same as `/dv`'s `call_control_id`? | `/mcp`, `/verify` log lines |
| 1 | Did echo get called mid-conversation? | `/mcp` `tools/call` log line |
| 3 | What did the `/verify` body contain: spoken values, or empty? | `/verify` log line |
| 3 | Which speak node played for 200 / 401 / 500? If "default" for 200, retry with numeric `200` | Ear + transcript |
| 4b | Change the webhook URL to `$B/dv?mode=fail`, then `?mode=slow`: hear "Route A", no raw `{{route}}`? | Ear + transcript |
