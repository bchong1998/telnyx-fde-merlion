// Local test for CustomerActor.attemptVerify + phone helpers + signature
// round-trip. Runs with plain Node (type stripping) — no edge runtime needed:
// the actor class only uses this.ctx.storage and this.env.MERLION_KV, which are
// stubbed in memory here.
//
//   node test/attempt-verify.test.mts

import assert from "node:assert/strict";
import { CustomerActor } from "../src/customer-actor.ts";
import { normalisePhone, maskPhone } from "../../shared/phone.ts";
import { verifyTelnyxSignature, SigError } from "../src/sig.ts";

// ---- in-memory stubs --------------------------------------------------------

function makeStorage() {
  const m = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return m.has(key) ? (m.get(key) as T) : undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      m.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return m.delete(key);
    },
    _map: m,
  };
}

function makeActor(customerId: string, kv: Record<string, string> = {}) {
  const storage = makeStorage();
  const ctx = { id: customerId, storage };
  const env = {
    MERLION_KV: {
      async get(key: string): Promise<string | null> {
        return kv[key] ?? null;
      },
    },
  };
  // Constructor shape is (ctx, env) per @telnyx/edge-runtime StatefulActor.
  return { actor: new CustomerActor(ctx as never, env as never), storage };
}

const ARGS = (match: boolean) => ({
  match,
  callControlId: "call_test_1",
  traceId: "trace_test_1",
});

// ---- 1. attempts reset on success -------------------------------------------

{
  const { actor } = makeActor("C001");
  let r = await actor.attemptVerify(ARGS(false));
  assert.equal(r.outcome, "failed");
  assert.equal(r.attempts, 1);
  assert.equal(r.attempts_remaining, 2);

  r = await actor.attemptVerify(ARGS(false));
  assert.equal(r.outcome, "failed");
  assert.equal(r.attempts, 2);
  assert.equal(r.attempts_remaining, 1);

  r = await actor.attemptVerify(ARGS(true));
  assert.equal(r.outcome, "verified");
  assert.equal(r.attempts, 0);
  assert.equal(r.attempts_remaining, 3);

  const s = await actor.getSummary("trace_test_1");
  assert.equal(s.locked, false);
  assert.equal(s.lockout_until_ms, null);
  assert.equal(s.has_open_case, false); // C001 has no seeded case
  console.log("PASS  success resets attempts");
}

// ---- 2. three failures lock; a correct answer while locked stays locked -----

{
  const { actor, storage } = makeActor("C003");
  await actor.attemptVerify(ARGS(false));
  await actor.attemptVerify(ARGS(false));
  let r = await actor.attemptVerify(ARGS(false));
  assert.equal(r.outcome, "locked");
  assert.equal(r.attempts, 3);
  assert.equal(r.attempts_remaining, 0);
  assert.ok(r.lockout_until_ms !== null);
  // lockout is a 15-minute constant (±15 s slack)
  assert.ok(Math.abs(r.lockout_until_ms! - (Date.now() + 15 * 60_000)) < 15_000);

  r = await actor.attemptVerify(ARGS(true)); // correct answer while locked
  assert.equal(r.outcome, "locked");

  // Expiry is lazy: backdate the lockout, then a correct answer verifies.
  storage._map.set("lockout_until", Date.now() - 1_000);
  r = await actor.attemptVerify(ARGS(true));
  assert.equal(r.outcome, "verified");
  r = await actor.getSummary("trace_test_1").then((s) => s as never);
  console.log("PASS  lockout at 3 failures (15-min constant); correct answer while locked stays locked; lazy expiry clears");
}

// ---- 3. seeded open-case persona (lazy seed by ctx.id) ----------------------

{
  const { actor } = makeActor("C002");
  const s = await actor.getSummary("trace_test_1");
  assert.equal(s.has_open_case, true);
  console.log("PASS  C002 seeded with an open case");
}

// ---- 5. phone helpers --------------------------------------------------------

assert.equal(normalisePhone("82925458"), "+6582925458");
assert.equal(normalisePhone("+6582925458"), "+6582925458");
assert.equal(normalisePhone("6582925458"), "+6582925458");
assert.equal(normalisePhone("xxxx@sip.telnyx.eu"), null);
assert.equal(normalisePhone("call me maybe"), null);
assert.equal(maskPhone("+6582925458"), "+65****5458");
console.log("PASS  phone normalise + mask");

// ---- 7. secure actions reject unverified calls -------------------------------

{
  const { actor } = makeActor("C004");
  assert.deepEqual(await actor.freezeCard({ callControlId: "call_X", reason: "r", traceId: "t" }), {
    status: "not_verified",
  });
  assert.deepEqual(
    await actor.openCase({ callControlId: "call_X", category: "suspicious_contact", summary: "s", traceId: "t" }),
    { status: "not_verified", case_id: null },
  );
  assert.deepEqual(await actor.getCases({ callControlId: "call_X", traceId: "t" }), {
    status: "not_verified",
    cases: [],
  });
  console.log("PASS  unverified calls rejected (freezeCard/openCase/getCases)");
}

// ---- 8. freezeCard: frozen then already_frozen -------------------------------

{
  const { actor } = makeActor("C004");
  await actor.attemptVerify({ match: true, callControlId: "call_A", traceId: "t" });
  assert.deepEqual(await actor.freezeCard({ callControlId: "call_A", reason: "fraud", traceId: "t" }), {
    status: "frozen",
  });
  assert.deepEqual(await actor.freezeCard({ callControlId: "call_A", reason: "fraud", traceId: "t" }), {
    status: "already_frozen",
  });
  // but NOT from a different call id
  assert.deepEqual(await actor.freezeCard({ callControlId: "call_B", reason: "fraud", traceId: "t" }), {
    status: "not_verified",
  });
  console.log("PASS  freezeCard: frozen → already_frozen, and per-call guard");
}

// ---- 9. openCase: idempotent per call; case_seq increments across calls ------

{
  const { actor } = makeActor("C004");
  await actor.attemptVerify({ match: true, callControlId: "call_A", traceId: "t" });
  const first = await actor.openCase({
    callControlId: "call_A",
    category: "money_transferred",
    amount_sgd: 1200,
    summary: "transferred to a 'safe account'",
    traceId: "t",
  });
  assert.deepEqual(first, { status: "opened", case_id: "MB-C004-1" });

  // same call → same case
  const again = await actor.openCase({
    callControlId: "call_A",
    category: "money_transferred",
    amount_sgd: 1200,
    summary: "transferred to a 'safe account'",
    traceId: "t",
  });
  assert.deepEqual(again, { status: "existing", case_id: "MB-C004-1" });

  // a new verified call → next sequence number
  await actor.attemptVerify({ match: true, callControlId: "call_B", traceId: "t" });
  const second = await actor.openCase({
    callControlId: "call_B",
    category: "credentials_shared",
    summary: "read out an OTP",
    traceId: "t",
  });
  assert.deepEqual(second, { status: "opened", case_id: "MB-C004-2" });

  const list = await actor.getCases({ callControlId: "call_B", traceId: "t" });
  assert.equal(list.status, "ok");
  assert.deepEqual(
    list.cases.map((c) => c.case_id),
    ["MB-C004-1", "MB-C004-2"],
  );
  console.log("PASS  openCase idempotent per call; case_seq increments across calls");
}

// ---- adminReset: wipe state; lazy seed re-arms the open-case persona --------

{
  const dirty = makeActor("C004");
  await dirty.actor.attemptVerify({ match: true, callControlId: "call_A", traceId: "t" });
  await dirty.actor.freezeCard({ callControlId: "call_A", reason: "r", traceId: "t" });
  await dirty.actor.openCase({ callControlId: "call_A", category: "suspicious_contact", summary: "s", traceId: "t" });
  await dirty.actor.adminReset("t");
  let s = await dirty.actor.getSummary("t");
  assert.deepEqual(s, { locked: false, lockout_until_ms: null, has_open_case: false, card_frozen: false });

  const seeded = makeActor("C002");
  await seeded.actor.adminReset("t");
  s = await seeded.actor.getSummary("t");
  assert.equal(s.has_open_case, true); // seed re-armed
  console.log("PASS  adminReset wipes state; C002 seed re-arms");
}

// ---- 6. signature round-trip -------------------------------------------------

{
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const pubB64 = Buffer.from(rawPub).toString("base64");

  const body = JSON.stringify({ hello: "merlion" });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = new Uint8Array(
    await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(`${ts}|${body}`)),
  );
  const headers = new Headers({
    "telnyx-signature-ed25519": Buffer.from(sig).toString("base64"),
    "telnyx-timestamp": ts,
  });

  assert.equal(await verifyTelnyxSignature(body, headers, pubB64), "ok");
  await assert.rejects(
    () => verifyTelnyxSignature(body + " ", headers, pubB64),
    SigError,
    "tampered body must fail",
  );
  const stale = new Headers({
    "telnyx-signature-ed25519": headers.get("telnyx-signature-ed25519")!,
    "telnyx-timestamp": String(Number(ts) - 301),
  });
  await assert.rejects(
    () => verifyTelnyxSignature(body, stale, pubB64),
    SigError,
    "stale timestamp must fail",
  );
  assert.equal(await verifyTelnyxSignature("anything", new Headers(), pubB64, true), "skipped");
  console.log("PASS  ed25519 signature round-trip (+ tamper/stale rejection, dev bypass)");
}

console.log("\nAll tests passed.");
