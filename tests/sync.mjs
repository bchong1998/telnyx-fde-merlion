#!/usr/bin/env node
// tests/sync.mjs — upsert tests/scenarios/*.json to the Telnyx Assistant Tests
// API (suite "merlion-regression"), idempotently matched by `name`.
// Writes tests/state.json { <scenario name>: { test_id, updated_at } }.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const API = "https://api.telnyx.com/v2";
const SUITE = "merlion-regression";
const DESTINATION = "assistant-48c6f37c-1b3b-42bb-aa83-62ab1d65cd65"; // web_chat: assistant id

function loadApiKey() {
  if (process.env.TELNYX_API_KEY) return process.env.TELNYX_API_KEY;
  const m = readFileSync(join(homedir(), ".telnyx-edge", "config.toml"), "utf8").match(/^api_key\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("no TELNYX_API_KEY available");
  return m[1];
}
const KEY = loadApiKey();

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const scenarios = readdirSync(join(DIR, "scenarios"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(DIR, "scenarios", f), "utf8")) }));

const existing = (await api("GET", "/ai/assistants/tests?page%5Bsize%5D=100")) ?? {};
const byName = new Map((existing.data ?? []).filter((t) => t.test_suite === SUITE).map((t) => [t.name, t]));

const statePath = join(DIR, "state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

for (const s of scenarios) {
  const channel = s.channels?.[0] ?? "web_chat";
  const body = {
    name: s.name,
    destination: channel === "phone_call" ? "+16018678604" : DESTINATION,
    telnyx_conversation_channel: channel,
    test_suite: SUITE,
    instructions: s.instructions,
    max_duration_seconds: s.max_duration_seconds,
    rubric: s.rubric,
  };
  const found = byName.get(s.name);
  if (found) {
    await api("PUT", `/ai/assistants/tests/${found.test_id}`, body);
    state[s.name] = { test_id: found.test_id, updated_at: new Date().toISOString(), action: "updated", channel };
  } else {
    const created = await api("POST", "/ai/assistants/tests", body);
    state[s.name] = { test_id: created.test_id, updated_at: new Date().toISOString(), action: "created", channel };
  }
  console.log(`${s.name.padEnd(28)} ${state[s.name].test_id} (${state[s.name].action}, ${channel})`);
}

writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
console.log(`synced ${scenarios.length} scenario(s) -> tests/state.json`);
