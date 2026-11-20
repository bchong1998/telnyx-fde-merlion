#!/usr/bin/env node
// tests/asserts.mjs — deterministic, log-based assertion evaluator.
//
//   node tests/asserts.mjs --scenario tests/scenarios/T2-case-status.json \
//        --messages evidence/tests/<ts>/T2-messages.json \
//        --webhook-logs <webhook.json> --mcp-logs <mcp.json> \
//        [--since 2026-11-19T11:00:00Z] [--until 2026-11-19T11:05:00Z]
//
// Asserts are evaluated from FUNCTION LOGS (truth for tool timing, dogfooding
// #28) and the conversation transcript. Prints JSON:
//   { scenario, ok, checks: [{name, ok, detail}] }
// Exits non-zero when any check fails. Usable offline against exported files.

import { readFileSync } from "node:fs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const scenarioPath = arg("scenario");
const messagesPath = arg("messages");
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
const asserts = scenario.asserts ?? {};

const sinceMs = arg("since") ? Date.parse(arg("since")) - 30_000 : -Infinity;
const untilMs = arg("until") ? Date.parse(arg("until")) + 30_000 : Infinity;

const parseLogs = (p) => {
  if (!p) return [];
  const d = JSON.parse(readFileSync(p, "utf8"));
  return (d.lines ?? d.logs ?? d.data ?? d)
    .filter((l) => typeof l?.message === "string" && l.message.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l.message);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

const whAll = parseLogs(arg("webhook-logs"));
const mcpAll = parseLogs(arg("mcp-logs"));
const messages = messagesPath ? (JSON.parse(readFileSync(messagesPath, "utf8")).data ?? []) : [];

// Window: when the transcript exists, scope to this conversation's own span
// (±15 s) — run.created_at sits in queue and would admit the PREVIOUS test's
// log lines (observed: prior scenario's /verify bleeding into this window).
const msgTs = messages
  .map((m) => Date.parse(m.created_at ?? m.sent_at ?? ""))
  .filter(Number.isFinite);
const winStart = msgTs.length ? Math.min(...msgTs) - 15_000 : sinceMs;
const winEnd = msgTs.length ? Math.max(...msgTs) + 15_000 : untilMs;
const inWindow = (m) => {
  const t = Date.parse(m.ts ?? "");
  return Number.isFinite(t) && t >= winStart && t <= winEnd;
};
const wh = whAll.filter(inWindow);
const mcp = mcpAll.filter(inWindow);

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

// ---- verify_outcomes: exact ordered list of /verify outcomes ------------------
if ("verify_outcomes" in asserts) {
  const got = wh.filter((m) => m.route === "/verify").map((m) => m.outcome);
  const want = asserts.verify_outcomes;
  const ok = got.length === want.length && got.every((o, i) => o === want[i]);
  add("verify_outcomes", ok, `want [${want.join(",")}] got [${got.join(",")}]`);
}

// ---- mcp_tool_outcomes: each required tool appears with the expected outcome --
if ("mcp_tool_outcomes" in asserts) {
  for (const [tool, want] of Object.entries(asserts.mcp_tool_outcomes)) {
    const hits = mcp.filter((m) => m.route === tool).map((m) => m.outcome);
    add(`mcp_tool_outcomes.${tool}`, hits.includes(want), `want ${tool}:${want} got [${hits.join(",")}]`);
  }
}

// ---- mcp_tool_not_ok: tool must never succeed (absent or denied is fine) -------
for (const tool of asserts.mcp_tool_not_ok ?? []) {
  const oks = mcp.filter((m) => m.route === tool && m.outcome === "ok");
  add(`mcp_tool_not_ok.${tool}`, oks.length === 0, `successful ${tool} calls: ${oks.length}`);
}

// ---- transcript tool presence/absence -----------------------------------------
const toolCalls = [];
for (const msg of messages) {
  for (const tc of msg.tool_calls ?? []) {
    const n = tc.function?.name;
    if (n) toolCalls.push(n);
  }
}
for (const t of asserts.transcript_tools_called ?? []) {
  add(`transcript_calls.${t}`, toolCalls.includes(t), `tools called: [${toolCalls.join(",")}]`);
}
for (const t of asserts.transcript_tools_absent ?? []) {
  add(`transcript_absent.${t}`, !toolCalls.includes(t), `tools called: [${toolCalls.join(",")}]`);
}

// NOTE (#34): the previous `no_verify_before` assert is REMOVED. It compared
// conversation message timestamps against function log timestamps; platform
// evidence shows conversation *message* stamps lag about one turn while
// function stamps are real-time, so the comparison produced false positives
// (see dogfooding #34 for the impossibility proof). Tool-before-yes ordering is
// now enforced by the verify_collect prompt itself, not by log timing.

const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ scenario: scenario.name, ok, checks }, null, 2));
process.exit(ok ? 0 : 1);
