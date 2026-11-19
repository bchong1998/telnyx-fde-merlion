// Re-export the actor class so it is bundled and shipped with the function;
// the exported class name must equal the [[actors]] type in telnyx.toml.
export { Counter } from "./counter";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

type LogBody = unknown;

interface ParsedRequest {
  url: URL;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: LogBody;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function parseRequest(req: Request, url: URL): Promise<ParsedRequest> {
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (query[k] = v));

  let body: LogBody = null;
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    const text = await req.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
  }
  return { url, query, headers, body };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Routes -----------------------------------------------------------------

async function handleDv(p: ParsedRequest): Promise<Response> {
  const mode = p.query.mode;
  if (mode === "fail") {
    return json({ error: "forced failure via ?mode=fail" }, 500);
  }
  if (mode === "slow") {
    await sleep(5000);
  }
  return json({ dynamic_variables: { route: "b", preferred_language: "en" } });
}

function handleVerify(p: ParsedRequest): Response {
  const bodyStatus =
    typeof p.body === "object" && p.body !== null && "force_status" in p.body
      ? (p.body as Record<string, unknown>).force_status
      : undefined;
  const raw = bodyStatus ?? p.query.force_status;
  let status = Number(raw);
  if (!Number.isInteger(status) || status < 100 || status > 599) status = 200;
  return json({ received: p.body }, status);
}

async function handleMcp(req: Request, p: ParsedRequest): Promise<Response> {
  // Stateless Streamable HTTP: fresh server + transport per request, no
  // session id, JSON responses (no SSE).
  const server = new McpServer({ name: "spike-fn-mcp", version: "0.1.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo text back along with request trace context",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({
      content: [
        {
          type: "text",
          text: `text=${text} trace=${p.query.trace ?? "(none)"} x-trace-id=${req.headers.get("x-trace-id") ?? "(none)"}`,
        },
      ],
    }),
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req, { parsedBody: p.body });
}

async function handleInc(env: Env, p: ParsedRequest): Promise<Response> {
  const name = p.query.name;
  if (!name) return json({ error: "query param 'name' required" }, 400);
  const value = await env.COUNTER.idFromName(name).increment();
  return json({ name, value });
}

async function handleKvInc(env: Env, p: ParsedRequest): Promise<Response> {
  const name = p.query.name;
  if (!name) return json({ error: "query param 'name' required" }, 400);
  const key = `counter/${name}`;
  // Deliberately racy: read-modify-write with no locking -> lost updates
  // under concurrency.
  const current = (await env.SPIKE_KV.get<number>(key, { type: "json" })) ?? 0;
  const next = current + 1;
  await env.SPIKE_KV.put(key, JSON.stringify(next));
  return json({ name, value: next });
}

async function route(req: Request, env: Env, p: ParsedRequest): Promise<Response> {
  const path = p.url.pathname;
  if (path === "/healthz" && req.method === "GET") return json({ ok: true });
  if (path === "/dv" && req.method === "POST") return handleDv(p);
  if (path === "/verify" && req.method === "POST") return handleVerify(p);
  if (path === "/mcp" && req.method === "POST") return handleMcp(req, p);
  if (path === "/inc" && req.method === "GET") return handleInc(env, p);
  if (path === "/kvinc" && req.method === "GET") return handleKvInc(env, p);
  return json({ error: "not found" }, 404);
}

// --- Entry point ------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const start = Date.now();
    const url = new URL(req.url);
    let status = 500;
    let parsed: ParsedRequest | null = null;
    let caught: unknown = null;
    try {
      parsed = await parseRequest(req, url);
      const res = await route(req, env, parsed);
      status = res.status;
      return res;
    } catch (err) {
      caught = err;
      status = 500;
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    } finally {
      // Exactly one JSON log line per request, even on throw.
      const line: Record<string, unknown> = {
        ts: new Date().toISOString(),
        route: url.pathname,
        method: req.method,
        query: parsed?.query ?? Object.fromEntries(url.searchParams),
        headers: parsed?.headers ?? {},
        body: parsed?.body ?? null,
        status,
        duration_ms: Date.now() - start,
      };
      if (caught) line.error = caught instanceof Error ? caught.message : String(caught);
      console.log(JSON.stringify(line));
    }
  },
};
