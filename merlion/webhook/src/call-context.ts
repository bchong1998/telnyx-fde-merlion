import { StatefulActor } from "@telnyx/edge-runtime";
import { logLine } from "../../shared/log.ts";

// Per-call context: which Merlion customer was resolved on this call
// (call_control_id → customer_id). Used by /verify when the model drops the
// `mobile` argument mid-call and the preset `caller` is a SIP address (web
// dialer), so no lookup is possible — without it the route returned not_found
// and the attempt was never counted (dogfooding #24).
//
// Entries expire CALL_MEMORY_TTL_MS after being written: makes reused
// synthetic call ids in tests harmless while any real call is far shorter.
const CALL_MEMORY_TTL_MS = 30 * 60_000;

interface CallMemory {
  customer_id: string;
  written_at: number;
}

export class CallContext extends StatefulActor {
  async setCustomer(args: { customerId: string; traceId: string }): Promise<{ ok: true }> {
    const t0 = Date.now();
    await this.ctx.storage.put("call", { customer_id: args.customerId, written_at: Date.now() });
    logLine({
      svc: "actor",
      route: "CallContext.setCustomer",
      trace_id: args.traceId,
      customer_id: args.customerId,
      outcome: "ok",
      status: 200,
      duration_ms: Date.now() - t0,
    });
    return { ok: true };
  }

  async getCustomer(args: { traceId: string }): Promise<{ customer_id: string | null }> {
    const t0 = Date.now();
    const mem = await this.ctx.storage.get<CallMemory>("call");
    let customerId = mem?.customer_id ?? null;
    if (mem && Date.now() - mem.written_at > CALL_MEMORY_TTL_MS) {
      await this.ctx.storage.delete("call");
      customerId = null;
    }
    logLine({
      svc: "actor",
      route: "CallContext.getCustomer",
      trace_id: args.traceId,
      customer_id: customerId,
      outcome: customerId ? "ok" : "miss",
      status: 200,
      duration_ms: Date.now() - t0,
    });
    return { customer_id: customerId };
  }
}
