# Demo script: Merlion Bank scam-response line

Format: **8–10 min live demo**, then a **7–10 min walkthrough of decisions**, then **5 min Q&A**.
Golden rule: every claim on screen has a file in `evidence/` behind it. If something breaks live, that's a chance to use the observability story (Part 3).

---

## T-30 min: pre-flight (do this *every* time, including rehearsals)

```sh
cd ~/coolbeans/redbean/telnyx-challenge
. ~/.config/merlion/admin.env
sh scripts/reset-demo.sh                 # → {"ok":true,"reset":["C001","C002","C003","C004"]}
scripts/probe.sh --once                  # 5/5 OK; exit 0
scripts/probe.sh &                       # leave running: keeps both functions warm (cold /dv ≈ 1.7 s)
```

- [ ] Phone: **Do Not Disturb OFF**, ringer on, charged. It's the "fraud specialist" transfer target.
- [ ] Portal → AI Assistants → `merlion-fraud-line` → **test call (WebRTC console)** open and the mic allowed. Live calls come from here, *not* your mobile: your mobile is Wei Ling's registered number *and* the transfer target.
- [ ] Headphones on the laptop, so the console audio doesn't echo into the call.
- [ ] Terminal layout (3 panes):
  1. Live webhook log:
     `telnyx-edge logs merlion-webhook --tail --json | jq -c '.message | fromjson? | {ts,route,outcome,customer_id,duration_ms,actor_ms}'`
  2. Live MCP log: the same command for `merlion-mcp`, using `tool` instead of `route`.
  3. A free shell for `trace.sh`, `metrics.sh`, `curl`.
- [ ] Browser tabs: README (architecture diagram), `docs/dogfooding-log.md`, GitHub Actions probe runs (green history).
- [ ] Fallback: a screen recording of a full rehearsal run (record it tonight), plus `evidence/observability/trace.txt`.

---

## Part 1: live demo (8–10 min)

### 0:00 Framing (30 s)
> "People in Singapore lost over S$1 billion to scams in 2024 *(check the latest SPF figure before you say it)*. When a bank customer realises they've been scammed, the minutes matter. They need the card frozen, a case opened, and a human, without the bank's phone line itself becoming an attack surface. This is Merlion Bank's scam line: a fictional bank, real Telnyx stack. One voice AI assistant with a conversation workflow, two Edge Compute functions, StatefulActors and KV."

Point at the architecture diagram for 10 seconds. Don't explain it yet.

### 0:30 Call 1: scam victim, end to end (~4 min). *The main event.*
Call from the Portal console. Narrate **between** turns, not over the assistant.

| You say | What to point at |
| --- | --- |
| *(listen)* | Welcome + **OTP disclosure**. "These are *speak* nodes, word for word. The model can't paraphrase compliance text." |
| "I got an SMS from Merlion Bank with a link, merlion-secure-verify dot com, and I clicked it and entered my OTP." | MCP pane: `check_scam_indicator ok`. It says it's a known scam and mentions 1799. |
| "Yes, please freeze my card." | It asks for the mobile number. "Caller ID isn't identity. Even if I called from the registered number, it wouldn't skip verification." |
| "Eight two nine two … five four five eight", then DOB "seventeenth April nineteen eighty-eight", card "four two five one" | It reads them back (naturally, "seventeenth of April, nineteen eighty-eight"). **Wait.** Point at the webhook pane: *no `/verify` yet.* "The live tail is real time. It only calls verify after I say yes. I once thought it didn't, and that's a story for the walkthrough." |
| "Yes." | Webhook pane: `/verify outcome=verified customer_id=C001 actor_ms≈30`. |
| *(freeze offered)* "Yes." | MCP pane: `freeze_card ok`, then `open_fraud_case ok`. It reads the case number digit by digit. "Note the model never passed a customer ID. The server resolves it from the verified binding for this call." |
| "Can I speak to someone?" | Transfer: **your phone rings**. Answer it, and you should hear the warm briefing (verified, first name, what happened). "The specialist starts with the context. The caller never repeats themselves." Hang up both legs. |

### 4:30 Call 2: the lockout (~2 min)
New console call. "Now someone trying to break into Mei Yun's account."

| You say | Point at |
| --- | --- |
| "I want to check my case." Mobile "nine eight seven six five four three two" | |
| DOB "first January nineteen seventy" ×3 (confirm each read-back with yes) | Webhook pane: `failed` (2 left), then `failed` (1 left), then `locked`. Then the **locked notice** speak node: branch with NRIC, 1799. |
| *(optional, if time)* Try once more with the right DOB, 30 June 1962 | Still `locked`. "The limit lives in the actor, not the prompt. The model can't be talked out of it." |

> "Attempts and lockout are a StatefulActor per customer. The webhook function owns it, and the MCP function binds the *same* actor type by reference, so verification and freeze/case gating share one source of truth with no sync layer."

### 6:30 Trace that call (~1.5 min)
```sh
scripts/trace.sh <conversation_id of Call 1>   # from the Portal conversation list, or scripts/recent.sh
```
> "One ID follows the call across the assistant, the webhook, the actors and the MCP server. Transcript turns and both functions' log lines on one timeline."

Scroll to the scam check. "Notice this tool call is stamped ~20 s *before* the message that contains the URL. Transcript stamps lag a turn, and I learned that the hard way (#34)."

### 8:00 Health and security from the outside (~1 min)
```sh
curl -s https://merlion-webhook-82dcb044-d.telnyxcompute.com/healthz?deep=1 | jq
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://merlion-webhook-82dcb044-d.telnyxcompute.com/verify -d '{}'   # 401
scripts/metrics.sh
```
> "`sig_enforced`, `bad_call_key_rejected`: each of those fields exists because of a specific incident in the log. The probe runs every 60 seconds from here and every 5 minutes from GitHub Actions." Show the green Actions history.

### (Optional, only if rehearsed) KV feature flag
There's currently **no command to set `flag/scam_surge_alert`**: no `kv` CLI command, and no admin route. Leave it out unless an `/admin/flag` route gets added. If it is added: toggle it, wait about 40 s (30 s SWR cache), call, and the surge notice plays after the disclosure. The stale-while-revalidate cache means the *first* call after a toggle may still get the old value. Say that out loud rather than get surprised by it.

---

## Part 2: walkthrough of decisions (7–10 min)

Use the README. One slide-worth each, and don't read it out.

1. **Workflow shape (1.5 min).**
   - Speak nodes for anything that must be said word for word.
   - Expression edges on webhook-returned variables for anything deterministic (`account_locked`, `verification_status`, `scam_surge_alert`, duration ≥ 300).
   - LLM edges only for intent.
   - No edge for `failed`: the actor enforces the limit.
2. **Why a model-called webhook tool and not a tool node (1 min).** Tool nodes skipped the HTTP call in 4 of 5 calls (#14). `store_fields_as_variables` only works on 2xx, so `/verify` always returns 200 with a business status (#16).
3. **State placement (1.5 min).**
   - Actors for per-customer and per-call state: ~30–60 ms warm.
   - KV only for flags: reads take ~1 s (#18).
   - `env.SECRETS.get()` is a 0.7 s RPC, so secrets come from deploy-time env (#23).
   - The `/dv` timeout is 3 s, and timing out is *silent*: the call continues with defaults. That's why the probe exists.
4. **Security model (2 min).**
   - Caller ID personalises but never authenticates.
   - Signed webhooks, MCP bearer token via integration secret, the model never supplies identity, fail closed on unresolved call keys.
5. **The three stories (3 min).** Pick the order based on Stephen's reactions:
   - **#26, a dev bypass left on in prod.** Caught by post-deploy probing. The ship had two HTTP 500s. Now it's a health field plus a probe check.
   - **#28 → #34, I was wrong.** I "proved" the model verified before "yes" and built a test for it. Then a tool call stamped before the caller had said the words showed the transcript stamps lag. Retracted, and the test was fixed. This is the best answer to "tell me about a mistake".
   - **#30, chat sessions sharing one auth key.** The `{{call_control_id}}` literal on web_chat. The tests surfaced it, but they *passed*: I only caught it by reading the evidence.
6. **AI tooling (1 min).**
   - OpenCode on Telnyx Inference wrote all the code. It was good at reading SDK types and at stopping when the platform failed.
   - Every serious bug passed its own tests. Review against live evidence is where the value was.
   - Point to the 35-entry dogfooding log, which includes the platform bugs: the Tests runner (#29), templating differences between surfaces (#30, #33), and the docs 404.

Close: "What I'd do next for a real bank: voicemail detection, native-reviewed language specialists, a 60 s external synthetic with paging, and a real core-banking backend behind the actors."

---

## If things go wrong live

| Symptom | Say / do |
| --- | --- |
| Call doesn't connect / silence > 5 s | "Let me show you how I'd find out." Run `scripts/probe.sh --once`, then `trace.sh` on the last conversation. Fall back to the recording. |
| Model double-speaks or misreads digits | Own it: "That's the voice-only surface the chat suite can't test. It's in the log as #22." Keep going. |
| Phone doesn't ring on transfer | Check DND. Otherwise: "The specialist is busy" path → `escalate_failed` is the designed fallback. |
| Lockout state wrong from a rehearsal | `sh scripts/reset-demo.sh` (takes 1 s). That's why it exists. |
| `/verify` slow (>1 s) | Cold start: the probe loop wasn't running. Mention the keep-warm design. |

## Rehearsal checklist (tonight)
- [ ] Full run with a stopwatch: Part 1 under 10 min.
- [ ] Record one clean run as the fallback.
- [ ] Reset the demo state after the rehearsal. Mei Yun will be locked.
- [ ] Note Call 1's conversation ID, in case `trace.sh` is slow to find it live.
