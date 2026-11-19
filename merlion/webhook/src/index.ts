// Re-export the actor class so it ships with the function (owner of CustomerActor).
export { CustomerActor } from "./customer-actor.ts";

import { logLine, type Outcome } from "../../shared/log.ts";
import { normalisePhone, maskPhone } from "../../shared/phone.ts";
import { SigError, verifyTelnyxSignature } from "./sig.ts";
import type { CustomerSummary } from "./customer-actor.ts";
import customersData from "../../shared/customers.json" with { type: "json" };

// ---- fixtures ---------------------------------------------------------------

interface Persona {
  customer_id: string;
  first_name: string;
  mobile_e164: string;
  dob: string;
  card_last4: string;
}
const personas: Persona[] = customersData.customers as Persona[];
const byMobile = new Map(personas.map((p) => [p.mobile_e164, p]));

// ---- helpers ----------------------------------------------------------------

const DV_BUDGET_MS = 2450; // /dv internal dependency budget (contract: 2500 ms; keep headroom)
const FLAG_TTL_MS = 30_000; // SWR soft TTL: flags visible ~30 s after a toggle

// Signature bypass toggle and secrets are read from injected environment
// variables: env.SECRETS.get() is an HTTP RPC per call (~0.7 s measured, see
// dogfooding entry — it costs as much as a KV read), while the same secrets
// are also injected as plain env vars (bindings doc). env var first,
// SECRETS.get as fallback for runtimes without the injection.
declare const process: { env: Record<string, string | undefined> };

async function secretValue(env: Env, name: "TELNYX_PUBLIC_KEY" | "DEV_SKIP_SIG" | "ADMIN_TOKEN"): Promise<string | null> {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined) return fromEnv;
  try {
    return await env.SECRETS.get(name);
  } catch {
    return null;
  }
}

async function devSkipEnabled(env: Env): Promise<boolean> {
  return (await secretValue(env, "DEV_SKIP_SIG")) === "true";
}

class DeadlineError extends Error {}
function race<T>(p: Promise<T>, ms: number): Promise<T> {
  const clamped = Math.max(ms, 150); // never fire a negative/absurd deadline
  return Promise.race([
    p,
    new Promise<T>((_res, rej) =>
      setTimeout(() => rej(new DeadlineError(`dependency deadline ${clamped}ms exceeded`)), clamped),
    ),
  ]);
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** "3:45 PM" — Singapore time, with a UTC fallback if ICU data is trimmed. */
function formatLockout(ms: number): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", hour12: true };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "Asia/Singapore" }).format(ms);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(ms);
  }
}

interface HopCtx {
  start: number;
  traceId: string;
  kvMs: Map<string, number>; // per-key KV timings
  actorMs: number | null; // summed actor-call timings
}

/**
 * Finalises a response: stamps X-Trace-Id + Server-Timing on it, writes the one
 * JSON log line, returns it. Never throws.
 */
function finish(
  res: Response,
  ctx: HopCtx,
  log: {
    svc: "webhook";
    route: string;
    outcome: Outcome;
    level?: "info" | "warn" | "error";
    conversationId?: string | null;
    callerMasked?: string | null;
    customerId?: string | null;
    err?: string | null;
  },
): Response {
  const duration = Date.now() - ctx.start;
  const kvMsTotal = [...ctx.kvMs.values()].reduce((a, b) => a + b, 0);
  const timings = [
    ...(ctx.kvMs.size ? [`kv;dur=${kvMsTotal}`] : []),
    ...(ctx.actorMs !== null ? [`actor;dur=${ctx.actorMs}`] : []),
    `total;dur=${duration}`,
  ].join(", ");
  const out = new Response(res.body, res);
  out.headers.set("X-Trace-Id", ctx.traceId);
  out.headers.set("Server-Timing", timings);
  logLine({
    svc: log.svc,
    route: log.route,
    trace_id: ctx.traceId,
    conversation_id: log.conversationId ?? null,
    caller_masked: log.callerMasked ?? null,
    customer_id: log.customerId ?? null,
    outcome: log.outcome,
    level: log.level,
    status: out.status,
    duration_ms: duration,
    kv_ms: ctx.kvMs.size ? kvMsTotal : undefined,
    actor_ms: ctx.actorMs ?? undefined,
    err: log.err,
  });
  return out;
}

async function kvGet(env: Env, key: string, ctx?: HopCtx): Promise<string | null> {
  const t0 = Date.now();
  try {
    return await env.MERLION_KV.get(key);
  } finally {
    ctx?.kvMs.set(key, Date.now() - t0);
  }
}

// KV reads on this platform cost ~0.9 s steady-state (see dogfooding #18/#21),
// so the operator flags ride an in-isolate SWR cache (eventual consistency is
// fine for flags per design §6): serve the cached value, revalidate in the
// background when stale; only the very first populate per isolate blocks.
// cfg/dev_skip_sig does NOT use KV — it is a deploy-time secret (see below).
const kvCache = new Map<string, { value: string | null; expires: number }>();

async function kvCachedSWR(env: Env, key: string, ttlMs: number, ctx: HopCtx): Promise<string | null> {
  const hit = kvCache.get(key);
  if (hit) {
    if (hit.expires <= Date.now()) {
      // Stale-while-revalidate: return the old value, refresh in background.
      kvGet(env, key)
        .then((value) => kvCache.set(key, { value, expires: Date.now() + ttlMs }))
        .catch(() => {});
    }
    return hit.value;
  }
  const value = await kvGet(env, key, ctx);
  kvCache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

async function actorCall<T>(ctx: HopCtx, p: Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await p;
  } finally {
    ctx.actorMs = (ctx.actorMs ?? 0) + (Date.now() - t0);
  }
}

// ---- signature gate ----------------------------------------------------------

async function checkSignature(
  rawBody: string,
  headers: Headers,
  env: Env,
): Promise<{ ok: boolean; skipped: boolean; err: string | null }> {
  if (await devSkipEnabled(env)) return { ok: true, skipped: true, err: null };
  try {
    const pub = await secretValue(env, "TELNYX_PUBLIC_KEY");
    if (!pub) throw new SigError("TELNYX_PUBLIC_KEY not available");
    await verifyTelnyxSignature(rawBody, headers, pub, false);
    return { ok: true, skipped: false, err: null };
  } catch (e) {
    return { ok: false, skipped: false, err: e instanceof SigError ? e.message : String(e) };
  }
}

// ---- routes ------------------------------------------------------------------

const DV_DEFAULTS = {
  preferred_language: "en",
  caller_known: "false",
  account_locked: "false",
  lockout_until: "",
  has_open_case: "false",
  scam_surge_alert: "false",
  surge_message: "",
};

async function handleDv(req: Request, env: Env, ctx: HopCtx, raw: string, payload: any): Promise<Response> {
  const base = {
    svc: "webhook" as const,
    route: "/dv",
    conversationId: payload?.telnyx_conversation_id ?? null,
  };

  const callerRaw: string | null = payload?.telnyx_end_user_target ?? payload?.from ?? null;
  const e164 = normalisePhone(callerRaw);
  const callerMasked = maskPhone(e164);
  const persona = e164 ? byMobile.get(e164) : undefined;

  // Flags ride the KV SWR cache; DEV_SKIP_SIG is a secret, so nothing here
  // touches KV serially. The actor summary runs concurrently (read-only).
  const flagP = kvCachedSWR(env, "flag/scam_surge_alert", FLAG_TTL_MS, ctx);
  const msgP = kvCachedSWR(env, "flag/surge_message", FLAG_TTL_MS, ctx);
  const summaryP: Promise<CustomerSummary | null> = persona
    ? actorCall(ctx, env.CUSTOMER.idFromName(persona.customer_id).getSummary(ctx.traceId))
    : Promise.resolve(null);

  const sig = await checkSignature(raw, req.headers, env);
  if (!sig.ok) {
    // Don't leak unhandled rejections from the prefetched deps.
    flagP.catch(() => {});
    msgP.catch(() => {});
    summaryP.catch(() => {});
    return finish(json({ error: "invalid signature" }, 401), ctx, { ...base, outcome: "denied", err: sig.err });
  }
  // Signature bypass active: every such request logs at warn level.
  const skipWarn = sig.skipped ? { level: "warn" as const } : {};

  // Dependency section under the internal budget: ANY failure → safe defaults,
  // outcome=fallback, still HTTP 200.
  try {
    const deadline = DV_BUDGET_MS - (Date.now() - ctx.start);
    const [summary, surgeFlag, surgeMsg] = await race(Promise.all([summaryP, flagP, msgP]), deadline);
    const locked = summary?.locked === true;
    const dv = {
      preferred_language: "en",
      caller_known: persona ? "true" : "false",
      account_locked: locked ? "true" : "false",
      lockout_until: locked && summary!.lockout_until_ms ? formatLockout(summary!.lockout_until_ms) : "",
      has_open_case: summary?.has_open_case ? "true" : "false",
      scam_surge_alert: surgeFlag === "true" ? "true" : "false",
      surge_message: surgeMsg ?? "",
    };
    const outcome: Outcome = !persona ? "miss" : locked ? "locked" : "ok";
    return finish(json({ dynamic_variables: dv }), ctx, {
      ...base,
      ...skipWarn,
      outcome,
      callerMasked,
      customerId: persona?.customer_id ?? null,
    });
  } catch (e) {
    return finish(json({ dynamic_variables: DV_DEFAULTS }), ctx, {
      ...base,
      ...skipWarn,
      outcome: "fallback",
      callerMasked,
      customerId: persona?.customer_id ?? null,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

async function handleVerify(req: Request, env: Env, ctx: HopCtx, raw: string, payload: any): Promise<Response> {
  const base = { svc: "webhook" as const, route: "/verify" };

  // No KV on this route at all: dev-skip is a secret read, the match is
  // computed from the bundled fixture, and the rest is one actor call.
  const sig = await checkSignature(raw, req.headers, env);
  if (!sig.ok) {
    return finish(json({ error: "invalid signature" }, 401), ctx, { ...base, outcome: "denied", err: sig.err });
  }
  const skipWarn = sig.skipped ? { level: "warn" as const } : {};

  // Resolve the customer: spoken registered mobile first, then platform caller.
  const e164 = normalisePhone(payload?.mobile) ?? normalisePhone(payload?.caller);
  const callerMasked = maskPhone(e164);
  const persona = e164 ? byMobile.get(e164) : undefined;
  if (!persona) {
    return finish(
      json({
        verification_status: "not_found",
        customer_id: "",
        first_name: "",
        attempts_remaining: "",
        lockout_until: "",
      }),
      ctx,
      { ...base, ...skipWarn, outcome: "not_found", callerMasked },
    );
  }

  // Only a boolean `match` ever reaches the actor — never DOB/card digits.
  const dob: unknown = payload?.dob;
  const last4 = String(payload?.last4 ?? "").replace(/\D/g, "");
  const match = typeof dob === "string" && dob === persona.dob && last4 === persona.card_last4;
  const callControlId = String(payload?.call_control_id ?? ctx.traceId);

  const r = await actorCall(
    ctx,
    env.CUSTOMER.idFromName(persona.customer_id).attemptVerify({
      match,
      callControlId,
      traceId: ctx.traceId,
    }),
  );
  const locked = r.outcome === "locked";
  return finish(
    json({
      verification_status: r.outcome,
      customer_id: persona.customer_id,
      first_name: r.outcome === "verified" ? persona.first_name : "",
      attempts_remaining: r.outcome === "locked" ? "0" : String(r.attempts_remaining),
      lockout_until: locked && r.lockout_until_ms ? formatLockout(r.lockout_until_ms) : "",
    }),
    ctx,
    { ...base, ...skipWarn, outcome: r.outcome, callerMasked, customerId: persona.customer_id },
  );
}

async function handleHealthz(env: Env, url: URL, ctx: HopCtx): Promise<Response> {
  const base = { svc: "webhook" as const, route: "/healthz" };
  if (url.searchParams.get("deep") !== "1") {
    return finish(json({ ok: true }), ctx, { ...base, outcome: "ok" });
  }

  // Deep probe: one KV read + one actor read against a probe instance.
  let kvOk = false;
  let actorOk = false;
  const errors: string[] = [];
  try {
    await kvGet(env, "flag/scam_surge_alert", ctx);
    kvOk = true;
  } catch (e) {
    errors.push(`kv: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await actorCall(ctx, env.CUSTOMER.idFromName("__health__").getSummary(ctx.traceId));
    actorOk = true;
  } catch (e) {
    errors.push(`actor: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ok = kvOk && actorOk;
  return finish(json({ ok, checks: { kv: kvOk, actor: actorOk } }, ok ? 200 : 503), ctx, {
    ...base,
    outcome: ok ? "ok" : "error",
    err: errors.length ? errors.join("; ") : null,
  });
}

async function handleAdminReset(req: Request, env: Env, ctx: HopCtx): Promise<Response> {
  const base = { svc: "webhook" as const, route: "/admin/reset" };
  const token = await secretValue(env, "ADMIN_TOKEN");
  const auth = req.headers.get("authorization");
  // Never exposed without a correctly bound secret AND a matching bearer token.
  if (!token || auth !== `Bearer ${token}`) {
    return finish(json({ error: "unauthorized" }, 401), ctx, {
      ...base,
      outcome: "denied",
      err: "bad or missing bearer token",
    });
  }
  const reset: string[] = [];
  for (const p of personas) {
    await actorCall(ctx, env.CUSTOMER.idFromName(p.customer_id).adminReset(ctx.traceId));
    reset.push(p.customer_id);
  }
  return finish(json({ ok: true, reset }), ctx, { ...base, outcome: "ok" });
}

// ---- entry point -------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const start = Date.now();
    const url = new URL(req.url);
    const ctx: HopCtx = { start, traceId: "", kvMs: new Map(), actorMs: null };

    const raw = req.method === "POST" ? await req.text() : "";
    let payload: any = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
    }
    ctx.traceId =
      payload?.call_control_id ??
      (typeof crypto !== "undefined" ? crypto.randomUUID() : String(Date.now()));

    try {
      if (url.pathname === "/dv" && req.method === "POST") {
        return await handleDv(req, env, ctx, raw, payload);
      }
      if (url.pathname === "/verify" && req.method === "POST") {
        return await handleVerify(req, env, ctx, raw, payload);
      }
      if (url.pathname === "/admin/reset" && req.method === "POST") {
        return await handleAdminReset(req, env, ctx);
      }
      if (url.pathname === "/healthz" && req.method === "GET") {
        return await handleHealthz(env, url, ctx);
      }
      return finish(json({ error: "not found" }, 404), ctx, {
        svc: "webhook",
        route: url.pathname,
        outcome: "miss",
      });
    } catch (err) {
      // Never throw without logging; never leak internals.
      return finish(json({ error: "internal error" }, 500), ctx, {
        svc: "webhook",
        route: url.pathname,
        outcome: "error",
        err: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
