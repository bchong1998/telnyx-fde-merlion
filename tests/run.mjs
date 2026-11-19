#!/usr/bin/env node
// tests/run.mjs [T1 T5 ...] — runs the regression suite sequentially against
// the live assistant via the Telnyx Assistant Tests API, then evaluates the
// deterministic asserts from function logs. Writes evidence/tests/<ts>/.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, "..");
const API = "https://api.telnyx.com/v2";

const KEY = process.env.TELNYX_API_KEY ??
  readFileSync(join(homedir(), ".telnyx-edge", "config.toml"), "utf8").match(/^api_key\s*=\s*"([^"]+)"/m)?.[1];
if (!KEY) throw new Error("no TELNYX_API_KEY");

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const selected = process.argv.slice(2).map((a) => a.toUpperCase());
const all = readdirSync(join(DIR, "scenarios"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ file: f, short: f.split("-")[0].toUpperCase(), ...JSON.parse(readFileSync(join(DIR, "scenarios", f), "utf8")) }));
const scenarios = all.filter((s) => selected.length === 0 || selected.includes(s.short));
if (!scenarios.length) throw new Error(`no scenarios selected (available: ${all.map((s) => s.short).join(", ")})`);

const state = JSON.parse(readFileSync(join(DIR, "state.json"), "utf8"));
const forScenario = (s) => {
  const t = state[s.name];
  if (!t) throw new Error(`scenario "${s.name}" not in tests/state.json — run: node tests/sync.mjs`);
  return t.test_id;
};

const tsDir = join(ROOT, "evidence", "tests", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(tsDir, { recursive: true });

const suiteStart = new Date(Date.now() - 5 * 60_000).toISOString();
const summaries = [];

async function runOne(s) {
  const testId = forScenario(s);
  const t0 = Date.now();
  const run = await api("POST", `/ai/assistants/tests/${testId}/runs`, {});
  writeFileSync(join(tsDir, `${s.short}-run-create.json`), JSON.stringify(run, null, 2));
  let cur = run;
  const statusPath = `/ai/assistants/tests/${testId}/runs/${run.run_id}`;
  for (let i = 0; i < 36; i++) {
    if (["passed", "failed", "error", "timeout"].includes(cur.status)) break;
    await sleep(10_000);
    cur = await api("GET", statusPath);
  }
  writeFileSync(join(tsDir, `${s.short}-run.json`), JSON.stringify(cur, null, 2));

  let messages = [];
  try {
    if (cur.conversation_id) {
      const m = await api("GET", `/ai/conversations/${cur.conversation_id}/messages?page%5Bsize%5D=100`);
      messages = m.data ?? [];
      writeFileSync(join(tsDir, `${s.short}-messages.json`), JSON.stringify({ data: messages }, null, 2));
    }
  } catch (e) {
    console.error(`  messages fetch failed for ${cur.conversation_id}: ${e.message}`);
  }

  return { scenario: s, run: cur, wallMs: Date.now() - t0 };
}

console.log("syncing scenario definitions ...");
execFileSync("node", [join(DIR, "sync.mjs")], { stdio: "inherit" });
// state.json may have been rewritten
const stateFresh = JSON.parse(readFileSync(join(DIR, "state.json"), "utf8"));
for (const k of Object.keys(state)) state[k] = stateFresh[k];

for (const s of scenarios) {
  const needsResetBefore = s.short === "T6"; // Daniel's path needs a clean slate
  if (needsResetBefore) {
    console.log("\n[reset before T6]");
    execFileSync(join(ROOT, "scripts", "reset-demo.sh"), { stdio: "inherit" });
  }
  console.log(`\n=== ${s.name} ===`);
  const r = await runOne(s);
  summaries.push(r);
  console.log(`  status=${r.run.status} turns=${r.run.turn_count} conversation=${r.run.conversation_id ?? "-"} (${(r.wallMs / 1000).toFixed(0)}s)`);
}

console.log("\nsleeping 15s for log ingestion, then fetching function logs ...");
await sleep(15_000);
mkdirSync(join(tsDir, "logs"), { recursive: true });
for (const [fn, dest] of [["merlion-webhook", "logs-webhook.json"], ["merlion-mcp", "logs-mcp.json"]]) {
  const out = execFileSync("telnyx-edge", ["logs", fn, "--type", "runtime", "--since", "2h", "--last", "250", "--json"], {
    encoding: "utf8",
  });
  writeFileSync(join(tsDir, "logs", dest), out);
}

console.log("evaluating asserts ...\n");
let allOk = true;
const table = [];
for (const { scenario: s, run, wallMs } of summaries) {
  const rubric = (run.detail_status ?? []).map((d) => ({ name: d.name, ok: d.status === "passed" }));
  const rubricOk = (run.detail_status ?? []).every((d) => d.status === "passed") && (run.detail_status ?? []).length > 0;
  let assertsRes;
  let assertsOut;
  try {
    assertsOut = execFileSync(
      "node",
      [
        join(DIR, "asserts.mjs"),
        "--scenario", join(DIR, "scenarios", s.file),
        "--messages", join(tsDir, `${s.short}-messages.json`),
        "--webhook-logs", join(tsDir, "logs", "logs-webhook.json"),
        "--mcp-logs", join(tsDir, "logs", "logs-mcp.json"),
        "--since", run.created_at,
        "--until", run.completed_at ?? new Date().toISOString(),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    // asserts.mjs exits 1 when assertions fail — that IS the result, not a crash
    assertsOut = (e.stdout ?? "").toString();
    if (!assertsOut.trim()) {
      assertsOut = JSON.stringify({
        scenario: s.name,
        ok: false,
        checks: [{ name: "evaluator", ok: false, detail: String(e.message).slice(0, 200) }],
      });
    }
  }
  const parsedAsserts = JSON.parse(assertsOut);
  writeFileSync(join(tsDir, `${s.short}-asserts.json`), assertsOut);
  const assertsOk = parsedAsserts.ok;
  const runOk = run.status === "passed";
  const ok = runOk && assertsOk;
  allOk &&= ok;
  table.push({
    test: s.name,
    run: run.status,
    rubric: rubric.map((r) => `${r.ok ? "✓" : "✗"} ${r.name}`).join("; "),
    asserts: assertsOk
      ? "✓ all"
      : "✗ " + parsedAsserts.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; "),
    conversation_id: run.conversation_id ?? "-",
    wall_s: +(wallMs / 1000).toFixed(0),
    ok,
  });
}

const tableText = table
  .map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.test.padEnd(24)} run=${r.run.padEnd(7)} asserts=${r.asserts} conv=${r.conversation_id} (${r.wall_s}s)\n         rubric: ${r.rubric}`)
  .join("\n");
console.log(tableText);
writeFileSync(join(tsDir, "table.txt"), tableText + "\n");
writeFileSync(join(tsDir, "suite.json"), JSON.stringify({ finished_at: new Date().toISOString(), ok: allOk, table }, null, 2));

console.log("\n[tearing down: reset demo state]");
try {
  execFileSync(join(ROOT, "scripts", "reset-demo.sh"), { stdio: "inherit" });
} catch (e) {
  console.error("reset failed (non-fatal for the suite):", e.shortMessage ?? e.message);
}
console.log(`\nevidence -> ${tsDir}`);
process.exit(allOk ? 0 : 1);
