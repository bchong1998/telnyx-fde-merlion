// Structured JSON logger, one line per request/hop (design §7 / §11 schema).
// Keys: ts, level, svc, route|tool, trace_id (=call_control_id), conversation_id,
// caller_masked, customer_id, outcome, status, duration_ms, kv_ms, actor_ms, err.
//
// Privacy: callers pass caller_masked via maskPhone(); DOB, card last-4 and full
// numbers never enter this schema — there is deliberately no body field.

export type Svc = "webhook" | "mcp" | "actor";
export type Outcome =
  | "ok"
  | "miss"
  | "locked"
  | "denied"
  | "error"
  | "fallback"
  | "verified"
  | "failed"
  | "not_found"
  | "not_verified"
  | "skipped"
  | "bad_call_key";

export interface LogFields {
  svc: Svc;
  route: string;
  status: number;
  duration_ms: number;
  trace_id?: string | null;
  conversation_id?: string | null;
  caller_masked?: string | null;
  customer_id?: string | null;
  outcome?: Outcome;
  kv_ms?: number;
  actor_ms?: number;
  err?: string | null;
  level?: "info" | "warn" | "error";
}

export function logLine(f: LogFields): void {
  const level =
    f.level ??
    (f.status >= 500 || f.outcome === "error"
      ? "error"
      : f.status >= 400 || f.outcome === "denied" || f.outcome === "fallback"
        ? "warn"
        : "info");
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      svc: f.svc,
      route: f.route,
      trace_id: f.trace_id ?? null,
      conversation_id: f.conversation_id ?? null,
      caller_masked: f.caller_masked ?? null,
      customer_id: f.customer_id ?? null,
      outcome: f.outcome ?? "ok",
      status: f.status,
      duration_ms: f.duration_ms,
      kv_ms: f.kv_ms ?? null,
      actor_ms: f.actor_ms ?? null,
      err: f.err ?? null,
    }),
  );
}
