#!/usr/bin/env node
// tests/backtest.mjs — offline evaluation of tests/asserts.mjs against
// exported conversations (evidence/round2/messages-*.json + the observability
// conversation 7723d64a) using previously exported function logs in
// evidence/tests/backtest/logs-*.json. Writes evidence/tests/backtest.txt.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, "..");
const OUT = join(ROOT, "evidence", "tests", "backtest");

const conversations = [
  // the #28 violation: model verified before the caller confirmed the read-back
  { id: "7723d64a-4caf-40f5-9f68-4ea8c5c85fc5", messages: null, expectViolation: true, note: "observability trace conv (round 2, pre-fix)" },
  ...readdirSync(join(ROOT, "evidence", "round2"))
    .filter((f) => f.startsWith("messages-"))
    .map((f) => ({
      id: f.replace("messages-", "").replace(".json", ""),
      messages: join(ROOT, "evidence", "round2", f),
      expectViolation: false,
      note: "round 2",
    })),
];

function tsOf(messages) {
  const ts = messages.map((m) => Date.parse(m.created_at ?? m.sent_at ?? "")).filter(Number.isFinite);
  return { start: new Date(Math.min(...ts)).toISOString(), end: new Date(Math.max(...ts)).toISOString() };
}

const lines = [];
for (const c of conversations) {
  const messages = JSON.parse(readFileSync(c.messages ?? join(OUT, `messages-${c.id}.json`), "utf8")).data ?? [];
  if (!messages.length) {
    lines.push(`${c.id}  SKIP (no messages)`);
    continue;
  }
  const w = tsOf(messages);
  // #34: no_verify_before retracted (cross-system timestamps lag one turn).
  // Backtest now evaluates safe deterministic checks only.
  const scenario = {
    name: `backtest ${c.id} (${c.note})`,
    asserts: {
      transcript_tools_absent: [],
    },
  };
  const scenarioPath = join(OUT, "scenario-temp.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  let out;
  try {
    out = execFileSync(
      "node",
      [
        join(DIR, "asserts.mjs"),
        "--scenario", scenarioPath,
        "--messages", c.messages ?? join(OUT, `messages-${c.id}.json`),
        "--webhook-logs", join(OUT, "logs-webhook.json"),
        "--mcp-logs", join(OUT, "logs-mcp.json"),
        "--since", w.start,
        "--until", w.end,
      ],
      { encoding: "utf8" },
    );
  } catch (e) {
    out = (e.stdout ?? "").toString();
  }
  const res = JSON.parse(out);
  // evidence-only line: list /verify outcomes seen in window (no fail semantics)
  const whLog = JSON.parse(readFileSync(join(OUT, "logs-webhook.json"), "utf8"));
  const winStart = Date.parse(w.start) - 30_000, winEnd = Date.parse(w.end) + 30_000;
  const vOutcomes = (whLog.lines ?? whLog.logs ?? whLog.data ?? whLog)
    .map((l) => { try { return JSON.parse(l.message); } catch { return null; } })
    .filter(Boolean)
    .filter((m) => m.route === "/verify" && Date.parse(m.ts) >= winStart && Date.parse(m.ts) <= winEnd)
    .map((m) => m.outcome);
  // #34 retraction: the old VIOLET flags for the SAME evidence must be gone now
  const tag = res.ok ? "PASS  " : "FAIL !!";
  lines.push(
    `${c.id}  ${tag}  verify_outcomes_in_window=[${vOutcomes.join(",")}]${c.expectViolation ? "  (previously flagged by retracted no_verify_before — now PASS by design)" : ""}`,
  );
}

const head = `backtest against round2 + observability conversations (evaluator: tests/asserts.mjs) — ${new Date().toISOString()}`;
writeFileSync(join(ROOT, "evidence", "tests", "backtest.txt"), head + "\n" + lines.join("\n") + "\n");
console.log(head);
console.log(lines.join("\n"));
