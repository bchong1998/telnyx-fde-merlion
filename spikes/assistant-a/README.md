# Spike assistant A (created via the Assistants API by Claude Code, 19 Nov)

Test harness only. Not solution code. Resources:
- Assistant `spike-a`: `assistant-38c61f30-aa0f-47bb-b2f4-b42af9d60a90` (model `zai-org/GLM-5.3-Flash`, greeting empty so the flow starts without a model greeting)
- MCP server `spike-mcp`: `00476101-c3ae-4fca-99e7-150f97e42c0c` → `$B/mcp?trace={{call_control_id}}` (type `http`)
- Shared tools: `save_verify_inputs` (update_dynamic_variables), `verify` (webhook, with preset body fields `trace_id={{call_control_id}}` and `caller`, and `store_fields_as_variables` echoed_dob ← `received.dob`), `spike_hangup`

Files: `*.json` = request bodies, `*.response.json` = API responses. Recreate with
`curl -H "Authorization: Bearer $TELNYX_API_KEY" -H 'content-type: application/json' https://api.telnyx.com/v2/ai/assistants -d @assistant-a.json`

Flow: entry --[route=="b"]--> speak_b / --[route=="a"]--> speak_a → collect (calls save_verify_inputs) --[dob,last4,force_status all != ""]--> verify_node (tool node)
--[status=="200"]--> s200 / --["401"]--> s401 / default → sdefault → hangup.
