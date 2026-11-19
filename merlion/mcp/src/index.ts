// merlion-mcp: stateless MCP Streamable HTTP server for the Merlion Bank voice
// assistant. REFERENCE binding to CustomerActor (no class shipped) + KV cache.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type {
  ActorNamespace,
  ActorStub,
  IdFromNameOptions,
  KvNamespace,
} from "@telnyx/edge-runtime";
import { logLine, type Outcome } from "../../shared/log.ts";
import { normalisePhone } from "../../shared/phone.ts";
import scamFeed from "../../shared/scam-feed.json" with { type: "json" };

// ---- reference actor stub (owner = merlion-webhook) -------------------------

type FreezeCardStatus = "frozen" | "already_frozen" | "not_verified";
type OpenCaseStatus = "opened" | "existing" | "not_verified";
interface CaseItem {
  case_id: string;
  category: string;
  status: string;
  opened_at: string;
}
interface CustomerStub extends ActorStub {
  freezeCard(a: { callControlId: string; reason: string; traceId: string }): Promise<{ status: FreezeCardStatus }>;
  openCase(a: {
    callControlId: string;
    category: string;
    amount_sgd?: number | null;
    summary: string;
    traceId: string;
  }): Promise<{ status: OpenCaseStatus; case_id: string | null }>;
  getCases(a: { callControlId: string; traceId: string }): Promise<{ status: "ok" | "not_verified"; cases: CaseItem[] }>;
  getSummary(traceId: string): Promise<{ locked: boolean; lockout_until_ms: number | null; has_open_case: boolean; card_frozen: boolean }>;
}
interface CustomerNS extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): CustomerStub;
}
interface Env {
  CUSTOMER: CustomerNS;
  MERLION_KV: KvNamespace;
  SECRETS?: { get(binding: string): Promise<string> };
}

// ---- request/log plumbing -----------------------------------------------------

interface HopCtx {
  start: number;
  traceId: string;
  kvMs: Map<string, number>;
  actorMs: number | null;
}

async function kvGet(env: Env, key: string, ctx: HopCtx): Promise<string | null> {
  const t0 = Date.now();
  try {
    return await env.MERLION_KV.get(key);
  } finally {
    ctx.kvMs.set(key, Date.now() - t0);
  }
}
async function actorCall<T>(ctx: HopCtx, p: Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await p;
  } finally {
    ctx.actorMs = (ctx.actorMs ?? 0) + (Date.now() - t0);
  }
}

function toolLog(
  ctx: HopCtx,
  tool: string,
  outcome: Outcome,
  startMs: number,
  extra: { customerId?: string | null; err?: string | null } = {},
): void {
  logLine({
    svc: "mcp",
    route: tool,
    trace_id: ctx.traceId || null,
    customer_id: extra.customerId ?? null,
    outcome,
    status: 200,
    duration_ms: Date.now() - startMs,
    kv_ms: ctx.kvMs.size ? [...ctx.kvMs.values()].reduce((a, b) => a + b, 0) : undefined,
    actor_ms: ctx.actorMs ?? undefined,
    err: extra.err,
  });
}

function finish(
  res: Response,
  ctx: HopCtx,
  log: { route: string; outcome: Outcome; err?: string | null },
): Response {
  const duration = Date.now() - ctx.start;
  const kvMsTotal = ctx.kvMs.size ? [...ctx.kvMs.values()].reduce((a, b) => a + b, 0) : 0;
  const timings = [
    ...(ctx.kvMs.size ? [`kv;dur=${kvMsTotal}`] : []),
    ...(ctx.actorMs !== null ? [`actor;dur=${ctx.actorMs}`] : []),
    `total;dur=${duration}`,
  ].join(", ");
  const out = new Response(res.body, res);
  if (ctx.traceId) out.headers.set("X-Trace-Id", ctx.traceId);
  out.headers.set("Server-Timing", timings);
  logLine({
    svc: "mcp",
    route: log.route,
    trace_id: ctx.traceId || null,
    outcome: log.outcome,
    status: out.status,
    duration_ms: duration,
    kv_ms: ctx.kvMs.size ? kvMsTotal : undefined,
    actor_ms: ctx.actorMs ?? undefined,
    err: log.err,
  });
  return out;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

// ---- scam indicator logic -----------------------------------------------------

type Verdict = "known_scam" | "suspicious" | "no_record";
interface VerdictRecord {
  verdict: Verdict;
  reason: string;
  advice: string;
}
interface FeedEntry extends VerdictRecord {
  kind: string;
  value: string;
}
const feed = scamFeed.indicators as FeedEntry[];

const SMS_HINTS = [
  "otp", "one-time", "password", "singpass", "cpf", "parcel", "customs", "fee",
  "police", "spf", "warrant", "arrest", "safe account", "verify your", "suspend",
  "click", "http", "link", "prize", "winner", "refund", "processing fee",
  "credit card", "debit card", "bank account", "transfer",
];

function normaliseIndicator(kind: string, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  switch (kind) {
    case "phone":
      return normalisePhone(v);
    case "url": {
      let s = v.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
      s = s.split(/[/?#]/)[0] ?? "";
      if (s.startsWith("www.")) s = s.slice(4);
      return s || null;
    }
    case "sms_text":
      return v.toLowerCase().replace(/\s+/g, " ").trim() || null;
    default:
      return null;
  }
}

const DEFAULT_ADVICE: Record<Verdict, string> = {
  known_scam: "Do not engage. Hang up, do not click any links, and never share codes or card details.",
  suspicious: "Treat it with caution. Do not click links or share one-time codes; check through the official app instead.",
  no_record: "I have no record of it, but stay cautious and never share one-time codes.",
};

function computeVerdict(kind: string, norm: string): VerdictRecord {
  if (kind === "phone" || kind === "url") {
    const hit = feed.find(
      (e) => e.kind === kind && (norm === e.value || (kind === "url" && norm.endsWith("." + e.value))),
    );
    if (hit) return { verdict: hit.verdict as Verdict, reason: hit.reason, advice: hit.advice };
    return {
      verdict: "no_record",
      reason: "This indicator is not in the current scam watchlist.",
      advice: DEFAULT_ADVICE.no_record,
    };
  }
  // sms_text: exact fixture match, then keyword heuristics
  const exact = feed.find((e) => e.kind === "sms_text" && norm === e.value.toLowerCase());
  if (exact) return { verdict: exact.verdict as Verdict, reason: exact.reason, advice: exact.advice };
  const hits = SMS_HINTS.filter((k) => norm.includes(k));
  if (hits.length > 0) {
    return {
      verdict: "suspicious",
      reason: `The text contains scam-style phrases: ${hits.slice(0, 4).join(", ")}.`,
      advice: DEFAULT_ADVICE.suspicious,
    };
  }
  return {
    verdict: "no_record",
    reason: "Nothing recognisably malicious in this text, and it is not in the scam watchlist.",
    advice: DEFAULT_ADVICE.no_record,
  };
}

async function checkScamIndicator(
  kind: "phone" | "url" | "sms_text",
  value: string,
): Promise<VerdictRecord> {
  // removed: KV cache — KV reads measured ~1 s from the assistant path, see
  // dogfooding #18/#21. The lookup below (bundled feed + heuristics) is ~0 ms.
  const norm = normaliseIndicator(kind, value);
  if (!norm) {
    return {
      verdict: "no_record",
      reason: "I could not parse that value as a " + kind + ".",
      advice: DEFAULT_ADVICE.no_record,
    };
  }
  return computeVerdict(kind, norm);
}

// ---- MCP server (fresh per request; stateless) --------------------------------

function buildServer(env: Env, ctx: HopCtx): McpServer {
  const server = new McpServer({ name: "merlion-mcp", version: "0.1.0" });
  const callControlId = ctx.traceId; // never a model-supplied argument

  server.registerTool(
    "check_scam_indicator",
    {
      description:
        "Check whether a phone number, a web link, or SMS message text is a known scam indicator. " +
        "Use this when the caller describes a suspicious call, message or link, before giving advice.",
      inputSchema: {
        kind: z.enum(["phone", "url", "sms_text"]).describe("What kind of indicator you are checking"),
        value: z.string().describe("The phone number, URL/domain, or full SMS text to check"),
      },
    },
    async ({ kind, value }) => {
      const t0 = Date.now();
      try {
        const rec = await checkScamIndicator(kind, value);
        toolLog(ctx, "check_scam_indicator", "ok", t0);
        const sentence =
          rec.verdict === "known_scam"
            ? `That is a known scam. ${rec.reason} ${rec.advice}`
            : rec.verdict === "suspicious"
              ? `That looks suspicious. ${rec.reason} ${rec.advice}`
              : `${rec.reason} ${rec.advice}`;
        return {
          content: [{ type: "text", text: sentence }],
          // cache removed (dogfooding #18/#21); field kept for response-shape stability
          structuredContent: { verdict: rec.verdict, reason: rec.reason, advice: rec.advice, cached: false },
        };
      } catch (e) {
        toolLog(ctx, "check_scam_indicator", "error", t0, { err: String(e) });
        return {
          content: [
            {
              type: "text",
              text: "Something went wrong while checking that. You may retry once; if it fails again, offer to connect a specialist.",
            },
          ],
          structuredContent: { retryable: true },
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "freeze_card",
    {
      description:
        "Freeze the caller's bank card immediately so no money can leave it. " +
        "Only use this after the caller's identity has been verified in this call, and after they confirm they want the card frozen.",
      inputSchema: {
        customer_id: z.string().describe("The verified caller's customer id, for example C001"),
        reason: z.string().describe("One short sentence about why the card is being frozen"),
      },
    },
    async ({ customer_id, reason }) => {
      const t0 = Date.now();
      try {
        const r = await actorCall(
          ctx,
          env.CUSTOMER.idFromName(customer_id).freezeCard({
            callControlId,
            reason,
            traceId: ctx.traceId,
          }),
        );
        toolLog(ctx, "freeze_card", r.status === "not_verified" ? "denied" : "ok", t0, {
          customerId: customer_id,
        });
        const byStatus: Record<FreezeCardStatus, string> = {
          frozen: "The card is now frozen. No new transactions can go through.",
          already_frozen: "The card was already frozen, so nothing changed — it is safe.",
          not_verified:
            "The caller's identity has not been verified in this call, so I cannot freeze the card. Please verify the caller first, then try again.",
        };
        return {
          content: [{ type: "text", text: byStatus[r.status] }],
          structuredContent: { status: r.status },
        };
      } catch (e) {
        toolLog(ctx, "freeze_card", "error", t0, { customerId: customer_id, err: String(e) });
        return {
          content: [
            { type: "text", text: "The freeze could not be completed. You may retry once; if it fails again, offer to connect a specialist." },
          ],
          structuredContent: { retryable: true },
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "open_fraud_case",
    {
      description:
        "Open a fraud case for the verified caller, recording what happened in one or two short sentences. " +
        "Only use this after the caller's identity has been verified in this call.",
      inputSchema: {
        customer_id: z.string().describe("The verified caller's customer id, for example C001"),
        category: z
          .enum(["money_transferred", "credentials_shared", "suspicious_contact"])
          .describe("money_transferred: caller already sent money; credentials_shared: caller revealed codes or card details; suspicious_contact: suspicious contact but nothing lost yet"),
        amount_sgd: z.number().optional().describe("Amount lost in Singapore dollars, if any"),
        summary: z.string().describe("One or two short sentences describing what happened"),
      },
    },
    async ({ customer_id, category, amount_sgd, summary }) => {
      const t0 = Date.now();
      try {
        const r = await actorCall(
          ctx,
          env.CUSTOMER.idFromName(customer_id).openCase({
            callControlId,
            category,
            amount_sgd: amount_sgd ?? null,
            summary,
            traceId: ctx.traceId,
          }),
        );
        toolLog(ctx, "open_fraud_case", r.status === "not_verified" ? "denied" : "ok", t0, {
          customerId: customer_id,
        });
        let text: string;
        if (r.status === "opened") {
          text = `Fraud case ${r.case_id} is now open. Our fraud team will review it today.`;
        } else if (r.status === "existing") {
          text = `Fraud case ${r.case_id} is already open for this call, so no duplicate was created.`;
        } else {
          text =
            "The caller's identity has not been verified in this call, so I cannot open a case. Please verify the caller first, then try again.";
        }
        return {
          content: [{ type: "text", text }],
          structuredContent: { status: r.status, case_id: r.case_id ?? undefined },
        };
      } catch (e) {
        toolLog(ctx, "open_fraud_case", "error", t0, { customerId: customer_id, err: String(e) });
        return {
          content: [
            { type: "text", text: "The case could not be opened right now. You may retry once; if it fails again, offer to connect a specialist." },
          ],
          structuredContent: { retryable: true },
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "get_case_status",
    {
      description:
        "Read back the fraud cases the verified caller already has, with each case number and status. " +
        "Only use this after the caller's identity has been verified in this call.",
      inputSchema: {
        customer_id: z.string().describe("The verified caller's customer id, for example C001"),
      },
    },
    async ({ customer_id }) => {
      const t0 = Date.now();
      try {
        const r = await actorCall(
          ctx,
          env.CUSTOMER.idFromName(customer_id).getCases({ callControlId, traceId: ctx.traceId }),
        );
        toolLog(ctx, "get_case_status", r.status === "not_verified" ? "denied" : "ok", t0, {
          customerId: customer_id,
        });
        if (r.status === "not_verified") {
          return {
            content: [
              {
                type: "text",
                text: "The caller's identity has not been verified in this call, so I cannot read case details. Please verify the caller first, then try again.",
              },
            ],
            structuredContent: { status: "not_verified" },
          };
        }
        const open = r.cases.filter((c) => c.status === "open");
        const text =
          r.cases.length === 0
            ? "There are no fraud cases on file for you yet."
            : `You have ${r.cases.length} case${r.cases.length === 1 ? "" : "s"}: ` +
              r.cases.map((c) => `${c.case_id}, ${c.category.replace(/_/g, " ")}, ${c.status}`).join("; ") +
              ".";
        return {
          content: [{ type: "text", text }],
          structuredContent: { status: "ok", open_count: open.length, cases: r.cases },
        };
      } catch (e) {
        toolLog(ctx, "get_case_status", "error", t0, { customerId: customer_id, err: String(e) });
        return {
          content: [
            { type: "text", text: "I could not read the case status right now. You may retry once; if it fails again, offer to connect a specialist." },
          ],
          structuredContent: { retryable: true },
          isError: true,
        };
      }
    },
  );

  return server;
}

// ---- optional bearer auth (only when MCP_TOKEN secret is bound) ---------------

async function checkAuth(req: Request, env: Env): Promise<boolean> {
  try {
    const secrets = env.SECRETS;
    if (!secrets) return true; // binding absent → auth skipped
    let token: string | null;
    try {
      token = await secrets.get("MCP_TOKEN");
    } catch {
      return true; // handle declared but missing → skip
    }
    if (!token) return true;
    return req.headers.get("authorization") === `Bearer ${token}`;
  } catch {
    return true;
  }
}

// ---- routes -------------------------------------------------------------------

async function handleHealthz(env: Env, url: URL, ctx: HopCtx): Promise<Response> {
  if (url.searchParams.get("deep") !== "1") {
    return finish(json({ ok: true }), ctx, { route: "/healthz", outcome: "ok" });
  }
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
    route: "/healthz",
    outcome: ok ? "ok" : "error",
    err: errors.length ? errors.join("; ") : null,
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const start = Date.now();
    const url = new URL(req.url);
    const ctx: HopCtx = { start, traceId: url.searchParams.get("trace") ?? "", kvMs: new Map(), actorMs: null };

    try {
      if (url.pathname === "/healthz" && req.method === "GET") {
        return await handleHealthz(env, url, ctx);
      }
      if (url.pathname === "/mcp" && req.method === "POST") {
        if (!(await checkAuth(req, env))) {
          return finish(json({ error: "unauthorized" }, 401), ctx, {
            route: "/mcp",
            outcome: "denied",
            err: "bad or missing bearer token",
          });
        }
        const server = buildServer(env, ctx);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
          enableJsonResponse: true, // JSON responses only, no SSE
        });
        await server.connect(transport);
        const res = await transport.handleRequest(req);
        return finish(res, ctx, { route: "/mcp", outcome: "ok" });
      }
      return finish(json({ error: "not found" }, 404), ctx, { route: url.pathname, outcome: "miss" });
    } catch (err) {
      return finish(json({ error: "internal error" }, 500), ctx, {
        route: url.pathname,
        outcome: "error",
        err: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
