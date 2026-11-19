// Reference function: ships NO actor class. [[actors]] in telnyx.toml declares
// type "Counter", which is owned by spike-fn — this binding routes to that
// same account-scoped actor and its state.
//
// The stub shape is narrowed by hand (mirrors the owner's Counter methods);
// note the type-only import — nothing from @telnyx/edge-runtime lands in the
// bundle, which is what makes this a class-free reference.
import type {
  ActorNamespace,
  ActorStub,
  IdFromNameOptions,
} from "@telnyx/edge-runtime";

type CounterStub = ActorStub & {
  increment(): Promise<number>;
};
interface CounterNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): CounterStub;
}
interface Env {
  COUNTER: CounterNamespace;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const start = Date.now();
    const url = new URL(req.url);
    let status = 500;
    let query: Record<string, string> = Object.fromEntries(url.searchParams);
    let headers: Record<string, string> = {};
    let caught: unknown = null;
    try {
      req.headers.forEach((v, k) => (headers[k] = v));

      let res: Response;
      if (url.pathname === "/inc" && req.method === "GET") {
        const name = query.name;
        if (!name) {
          res = json({ error: "query param 'name' required" }, 400);
        } else {
          const value = await env.COUNTER.idFromName(name).increment();
          res = json({ name, value, fn: "spike-fn2" });
        }
      } else {
        res = json({ error: "not found" }, 404);
      }
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
        query,
        headers,
        body: null,
        status,
        duration_ms: Date.now() - start,
      };
      if (caught) line.error = caught instanceof Error ? caught.message : String(caught);
      console.log(JSON.stringify(line));
    }
  },
};
