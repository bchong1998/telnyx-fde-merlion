#!/usr/bin/env node
// Idempotent deploy for the Merlion fraud-line assistant (config-as-code).
//
//   TELNYX_API_KEY=KEY... node assistant/deploy.mjs
//
// Creates-or-updates (matched by name) the shared tools, MCP server config,
// assistant, TeXML application and phone-number voice assignment; writes IDs
// to assistant/state.json; GETs the assistant back and diffs it against
// assistant/assistant.json (results in assistant/assistant.live.json and
// assistant/diff.txt).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const API = "https://api.telnyx.com/v2";

// ---- auth -------------------------------------------------------------------

function loadApiKey() {
  if (process.env.TELNYX_API_KEY) return process.env.TELNYX_API_KEY;
  const p = join(homedir(), ".telnyx-edge", "config.toml");
  if (existsSync(p)) {
    const m = readFileSync(p, "utf8").match(/^api_key\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  }
  console.error("No TELNYX_API_KEY in env and none found in ~/.telnyx-edge/config.toml");
  process.exit(1);
}
const KEY = loadApiKey();

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> HTTP ${res.status}: ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return parsed;
}

// ---- validation (run on assistant.json before any API call) ------------------

function validateFlow(assistant) {
  const errors = [];
  const warnings = [];
  const flow = assistant.conversation_flow;
  if (!flow) errors.push("conversation_flow missing");
  const nodes = flow?.nodes ?? [];
  const edges = flow?.edges ?? [];
  const byId = new Map();
  for (const n of nodes) {
    if (byId.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
    byId.set(n.id, n);
  }
  if (!byId.has(flow?.start_node_id)) errors.push(`start_node_id "${flow?.start_node_id}" is not a node`);
  const edgeIds = new Set();
  for (const e of edges) {
    if (edgeIds.has(e.id)) errors.push(`duplicate edge id "${e.id}"`);
    edgeIds.add(e.id);
    if (!byId.has(e.start_node_id)) errors.push(`edge ${e.id}: start_node_id "${e.start_node_id}" is not a node`);
    if (e.target?.type === "node" && !byId.has(e.target.node_id))
      errors.push(`edge ${e.id}: target node "${e.target.node_id}" is not a node`);
    if (!["node", "assistant"].includes(e.target?.type)) errors.push(`edge ${e.id}: unknown target type`);
    if (!["llm", "expression", "default"].includes(e.condition?.type))
      errors.push(`edge ${e.id}: unknown condition type "${e.condition?.type}"`);
  }
  for (const n of nodes) {
    const out = edges.filter((e) => e.start_node_id === n.id);
    const defaults = out.filter((e) => e.condition?.type === "default");
    if (n.type === "prompt") {
      if (n.instructions_mode !== "append")
        errors.push(`prompt node ${n.id}: instructions_mode is "${n.instructions_mode ?? "unset"}", must be "append"`);
      if (defaults.length > 0) errors.push(`prompt node ${n.id} has a default edge (forbidden)`);
    } else if (n.type === "speak" || n.type === "tool") {
      // platform rule: with any outgoing edge, exactly one default; zero edges = valid terminal
      if (out.length > 0 && defaults.length !== 1)
        errors.push(`${n.type} node ${n.id} has ${defaults.length} default edges (must be exactly 1)`);
    } else {
      warnings.push(`node ${n.id}: unknown type "${n.type}"`);
    }
  }
  // reachability from start
  const seen = new Set([flow.start_node_id]);
  const queue = [flow.start_node_id];
  while (queue.length) {
    const id = queue.shift();
    for (const e of edges.filter((e) => e.start_node_id === id)) {
      const t = e.target?.node_id;
      if (t && !seen.has(t)) {
        seen.add(t);
        queue.push(t);
      }
    }
  }
  for (const n of nodes) if (!seen.has(n.id)) warnings.push(`node ${n.id} is unreachable from start`);
  return { errors, warnings };
}

// ---- idempotent resource helpers --------------------------------------------

async function upsertSharedTool(file) {
  const def = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  const list = await api("GET", "/ai/tools?page%5Bsize%5D=100");
  const existing = (list.data ?? list ?? []).find((t) => t.display_name === def.display_name);
  if (existing) {
    await api("PATCH", `/ai/tools/${existing.id}`, def);
    return { id: existing.id, action: "updated" };
  }
  const created = await api("POST", "/ai/tools", def);
  return { id: created.data?.id ?? created.id, action: "created" };
}

async function upsertMcpServer() {
  const def = JSON.parse(readFileSync(join(DIR, "mcp-server.json"), "utf8"));
  const list = await api("GET", "/ai/mcp_servers?page%5Bsize%5D=100");
  const servers = Array.isArray(list.data) ? list.data : (list ?? []);
  const existing = servers.find((s) => s.name === def.name);
  if (existing) {
    await api("PUT", `/ai/mcp_servers/${existing.id}`, def); // MCP servers update via PUT (PATCH 404s)
    return { id: existing.id, action: "updated" };
  }
  const created = await api("POST", "/ai/mcp_servers", def);
  return { id: created.data?.id ?? created.id, action: "created" };
}

// The MCP bearer token lives in ~/.config/merlion/admin.env (MCP_TOKEN=…) —
// it is NEVER read from, or written into, this repo. The assistant references
// it by integration-secret identifier (mcp-server.json: api_key_ref).
function readLocalSecret(name) {
  const p = join(homedir(), ".config", "merlion", "admin.env");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(new RegExp(`^export ${name}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

async function upsertIntegrationSecret(identifier, token) {
  // /v2/integration_secrets/{id} has NO update verb (OpenAPI: delete only), so
  // "rotation" = delete + recreate. The value is identical, so this is atomic-ish
  // in practice (new id ready before anything rotates).
  const list = await api("GET", "/integration_secrets?page%5Bsize%5D=100");
  const existing = (list.data ?? []).find((s) => s.identifier === identifier);
  if (existing) {
    await api("DELETE", `/integration_secrets/${existing.id}`);
  }
  const created = await api("POST", "/integration_secrets", { identifier, type: "bearer", token });
  return { id: created.data?.id ?? created.id, action: existing ? "recreated" : "created" };
}

async function upsertAssistant(body) {
  const list = await api("GET", "/ai/assistants?page%5Bsize%5D=100");
  const existing = (list.data ?? []).find((a) => a.name === body.name);
  if (existing) {
    await api("POST", `/ai/assistants/${existing.id}`, body);
    return { id: existing.id, action: "updated" };
  }
  const created = await api("POST", "/ai/assistants", body);
  return { id: created.data?.id ?? created.id, action: "created" };
}

async function upsertTexmlApp(assistantId) {
  const friendly = "merlion-fraud-line";
  const voice_url = `https://api.telnyx.com/v2/ai/assistants/${assistantId}/texml`;
  const list = await api("GET", "/texml_applications");
  const existing = (list.data ?? []).find((a) => a.friendly_name === friendly);
  if (existing) {
    await api("PATCH", `/texml_applications/${existing.id}`, { friendly_name: friendly, voice_url });
    return { id: existing.id, action: "updated" };
  }
  const created = await api("POST", "/texml_applications", { friendly_name: friendly, voice_url });
  const id = created.data?.id ?? created.id;
  return { id, action: "created" };
}

async function assignPhone(texmlAppId) {
  const list = await api("GET", "/phone_numbers");
  const active = (list.data ?? []).filter((n) => n.status === "active");
  const number = active.find((n) => n.phone_number === "+16018678604") ?? active[0];
  if (!number) throw new Error("no active phone number on the account");
  await api("PATCH", `/phone_numbers/${number.id}/voice`, { connection_id: texmlAppId });
  return { id: number.id, phone_number: number.phone_number };
}

// Pronunciation dictionary (config-as-code): upsert by name and attach via the
// assistant's voice_settings.pronunciation_dict_id (untyped in the node SDK's
// VoiceSettings, but live in the v2 API — dogfooding #37).
async function upsertPronunciationDict() {
  const name = "merlion-brand";
  const items = [
    { text: "Merlion", type: "alias", alias: "Mer-lion" },
    { text: "gov.sg", type: "alias", alias: "guv dot S G" },
  ];
  const list = await api("GET", "/pronunciation_dicts?page%5Bsize%5D=100");
  const existing = (list.data ?? []).find((d) => d.name === name);
  if (existing) {
    await api("PATCH", `/pronunciation_dicts/${existing.id}`, { items });
    return { id: existing.id, action: "updated" };
  }
  const created = await api("POST", "/pronunciation_dicts", { name, items });
  return { id: created.data?.id ?? created.id, action: "created" };
}

async function attachPronunciationDict(assistantId, dictId) {
  const cur = await api("GET", `/ai/assistants/${assistantId}`);
  const live = cur.data ?? cur;
  const body = {
    ...live,
    voice_settings: { ...(live.voice_settings ?? {}), pronunciation_dict_id: dictId },
  };
  delete body.id;
  delete body.created_at;
  delete body.updated_at;
  delete body.version;
  await api("POST", `/ai/assistants/${assistantId}`, body);
}

// ---- diff: compare what we sent against what the API returns -----------------

function leaves(obj, prefix = "") {
  const out = {};
  if (obj === null || typeof obj !== "object") {
    out[prefix] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") Object.assign(out, leaves(v, p));
    else out[p] = v;
  }
  return out;
}

function diffAssistant(sent, live) {
  const a = leaves(sent);
  const diffs = [];
  const liveFlat = leaves(live);
  for (const [p, v] of Object.entries(a)) {
    if (!(p in liveFlat)) diffs.push(`DROPPED  ${p} = ${JSON.stringify(v)}  (absent in live response)`);
    else if (JSON.stringify(liveFlat[p]) !== JSON.stringify(v))
      diffs.push(`CHANGED  ${p}: sent ${JSON.stringify(v)} -> live ${JSON.stringify(liveFlat[p])}`);
  }
  for (const p of Object.keys(liveFlat)) {
    if (!(p in a) && /^(conversation_flow|dynamic_variables|mcp_servers|instructions|model|greeting)\./.test(p))
      diffs.push(`ADDED    ${p} = ${JSON.stringify(liveFlat[p])}  (only in live response)`);
  }
  return diffs;
}

// ---- main ---------------------------------------------------------------------

async function main() {
  console.log("1/6 validating assistant.json ...");
  const assistantRaw = readFileSync(join(DIR, "assistant.json"), "utf8");
  const assistant = JSON.parse(assistantRaw);
  const { errors, warnings } = validateFlow(assistant);
  for (const w of warnings) console.log("   warn:", w);
  if (errors.length) {
    for (const e of errors) console.error("   FAIL:", e);
    process.exit(1);
  }
  console.log(`   ok (${assistant.conversation_flow.nodes.length} nodes, ${assistant.conversation_flow.edges.length} edges)`);

  console.log("2/6 upserting shared tools ...");
  const verify = await upsertSharedTool("tools/verify.json");
  const transfer = await upsertSharedTool("tools/transfer.json");
  const hangup = await upsertSharedTool("tools/hangup.json");
  console.log(`   verify   ${verify.id} (${verify.action})`);
  console.log(`   transfer ${transfer.id} (${transfer.action})`);
  console.log(`   hangup   ${hangup.id} (${hangup.action})`);

  console.log("3/6 upserting MCP server ...");
  const mcp = await upsertMcpServer();
  console.log(`   mcp      ${mcp.id} (${mcp.action})`);
  const mcpToken = readLocalSecret("MCP_TOKEN");
  if (mcpToken) {
    const intsec = await upsertIntegrationSecret("merlion_mcp_token", mcpToken);
    console.log(`   intsecret merlion_mcp_token (${intsec.action}) — token from ~/.config/merlion/admin.env`);
  } else {
    console.log("   warn: MCP_TOKEN not in ~/.config/merlion/admin.env — MCP auth left as-is");
  }

  console.log("4/6 upserting assistant ...");
  const body = assistantRaw
    .replaceAll("__VERIFY_TOOL_ID__", verify.id)
    .replaceAll("__TRANSFER_TOOL_ID__", transfer.id)
    .replaceAll("__HANGUP_TOOL_ID__", hangup.id)
    .replaceAll("__MCP_SERVER_ID__", mcp.id);
  if (/__\w+__/.test(body)) throw new Error("unreplaced placeholder remains");
  const sentBody = JSON.parse(body);
  const asst = await upsertAssistant(sentBody);
  console.log(`   assistant ${asst.id} (${asst.action})`);

  console.log("5/6 wiring phone number ...");
  const texml = await upsertTexmlApp(asst.id);
  const phone = await assignPhone(texml.id);
  console.log(`   texml app ${texml.id} (${texml.action})`);
  console.log(`   ${phone.phone_number} voice connection -> texml app`);
  const dict = await upsertPronunciationDict();
  await attachPronunciationDict(asst.id, dict.id);
  console.log(`   pronunciation dict ${dict.id} (${dict.action}) attached via voice_settings.pronunciation_dict_id`);

  const state = {
    updated_at: new Date().toISOString(),
    assistant_id: asst.id,
    mcp_server_id: mcp.id,
    tools: { verify: verify.id, transfer: transfer.id, hangup: hangup.id },
    texml_app_id: texml.id,
    pronunciation_dict_id: dict.id,
    phone_number: phone.phone_number,
    phone_number_id: phone.id,
  };
  writeFileSync(join(DIR, "state.json"), JSON.stringify(state, null, 2) + "\n");

  console.log("6/6 GET assistant back & diffing ...");
  const live = await api("GET", `/ai/assistants/${asst.id}`);
  const liveData = live.data ?? live;
  writeFileSync(join(DIR, "assistant.live.json"), JSON.stringify(liveData, null, 2) + "\n");
  const diffs = diffAssistant(sentBody, liveData);
  writeFileSync(
    join(DIR, "diff.txt"),
    diffs.length ? diffs.join("\n") + "\n" : "no differences: every sent field is present and unchanged\n",
  );
  console.log(diffs.length ? `   ${diffs.length} difference(s) -> assistant/diff.txt` : "   no differences");
  for (const d of diffs.slice(0, 20)) console.log("   " + d);

  console.log("\nSummary");
  console.log("  assistant:", asst.id);
  console.log("  phone:    ", phone.phone_number, "-> TeXML", texml.id, "->", asst.id);
  console.log("  state:     assistant/state.json");
}

main().catch((e) => {
  console.error("\nDEPLOY FAILED:", e.message);
  process.exit(1);
});
