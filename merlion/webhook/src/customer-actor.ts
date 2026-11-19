import { StatefulActor } from "@telnyx/edge-runtime";
import { logLine } from "../../shared/log.ts";
import customersData from "../../shared/customers.json" with { type: "json" };

// ---- types -----------------------------------------------------------------

export interface FraudCase {
  case_id: string;
  category: string;
  status: "open" | "closed";
  amount_sgd: number | null;
  summary: string;
  opened_at: string;
  opened_by_call?: string; // set by openCase; absent on fixture-seeded cases
}

export interface CustomerSummary {
  locked: boolean;
  lockout_until_ms: number | null;
  has_open_case: boolean;
  card_frozen: boolean;
}

export type VerifyOutcome = "verified" | "failed" | "locked";

export interface VerifyResult {
  outcome: VerifyOutcome;
  attempts: number;
  attempts_remaining: number;
  lockout_until_ms: number | null;
}

export type FreezeCardStatus = "frozen" | "already_frozen" | "not_verified";
export type OpenCaseStatus = "opened" | "existing" | "not_verified";
export type GetCasesStatus = "ok" | "not_verified";

// Methods that touch customer data (read or write) require an exact match on
// verified_call_id — the model can pass any customer_id, and the actor refuses
// unless that customer was verified on this exact call.
const VERIFIED_REQUIRED = "not_verified" as const;

const MAX_ATTEMPTS = 3;
// Lockout minutes is a deploy-time constant: the previous KV read cost ~1 s on
// the mid-call path (see dogfooding #18/#21). Change requires a redeploy.
const LOCKOUT_MINUTES = 15;

interface PersonaCaseSeed {
  seed_case?: FraudCase;
}
const personas: Record<string, PersonaCaseSeed> = Object.fromEntries(
  customersData.customers.map((c) => [c.customer_id, c as PersonaCaseSeed]),
);

// ---- actor -----------------------------------------------------------------

/**
 * CustomerActor (key = customer_id) owns verification state as a single-
 * threaded read-modify-write: attempts, lockout_until, verified_call_id,
 * card_frozen, cases, case_seq. It never receives DOB or card digits — only a
 * boolean `match` computed by the calling function.
 */
export class CustomerActor extends StatefulActor<Env> {
  private async load(): Promise<{
    attempts: number;
    lockout_until: number | null;
    verified_call_id: string | null;
    card_frozen: boolean;
    cases: FraudCase[];
    case_seq: number;
  }> {
    const s = this.ctx.storage;
    // Lazy one-time seed of the demo persona's open case (this.ctx.id is the
    // name passed to idFromName).
    if (!(await s.get<number>("seeded"))) {
      const seed = personas[this.ctx.id]?.seed_case;
      if (seed && !(await s.get<FraudCase[]>("cases"))) {
        await s.put("cases", [seed]);
        await s.put("case_seq", 1);
      }
      await s.put("seeded", 1);
    }
    return {
      attempts: (await s.get<number>("attempts")) ?? 0,
      lockout_until: (await s.get<number>("lockout_until")) ?? null,
      verified_call_id: (await s.get<string>("verified_call_id")) ?? null,
      card_frozen: (await s.get<boolean>("card_frozen")) ?? false,
      cases: (await s.get<FraudCase[]>("cases")) ?? [],
      case_seq: (await s.get<number>("case_seq")) ?? 0,
    };
  }

  /** Lazily clear an expired lockout; returns true while still locked. */
  private async enforceLockout(state: { attempts: number; lockout_until: number | null }): Promise<boolean> {
    if (state.lockout_until === null) return false;
    if (Date.now() >= state.lockout_until) {
      await this.ctx.storage.put("lockout_until", null);
      await this.ctx.storage.put("attempts", 0);
      state.lockout_until = null;
      state.attempts = 0;
      return false;
    }
    return true;
  }

  private async lockoutMinutes(): Promise<number> {
    return LOCKOUT_MINUTES;
  }

  async getSummary(traceId: string): Promise<CustomerSummary> {
    const t0 = Date.now();
    const state = await this.load();
    const locked = await this.enforceLockout(state);
    logLine({
      svc: "actor",
      route: "CustomerActor.getSummary",
      trace_id: traceId,
      customer_id: this.ctx.id,
      outcome: locked ? "locked" : "ok",
      status: 200,
      duration_ms: Date.now() - t0,
    });
    return {
      locked,
      lockout_until_ms: state.lockout_until,
      has_open_case: state.cases.some((c) => c.status === "open"),
      card_frozen: state.card_frozen,
    };
  }

  async attemptVerify(args: {
    match: boolean;
    callControlId: string;
    traceId: string;
  }): Promise<VerifyResult> {
    const t0 = Date.now();
    const state = await this.load();
    let result: VerifyResult;

    if (await this.enforceLockout(state)) {
      result = {
        outcome: "locked",
        attempts: state.attempts,
        attempts_remaining: 0,
        lockout_until_ms: state.lockout_until,
      };
    } else if (args.match) {
      await this.ctx.storage.put("attempts", 0);
      await this.ctx.storage.put("verified_call_id", args.callControlId);
      result = {
        outcome: "verified",
        attempts: 0,
        attempts_remaining: MAX_ATTEMPTS,
        lockout_until_ms: null,
      };
    } else {
      const attempts = state.attempts + 1;
      await this.ctx.storage.put("attempts", attempts);
      if (attempts >= MAX_ATTEMPTS) {
        const minutes = await this.lockoutMinutes();
        const lockoutUntil = Date.now() + minutes * 60_000;
        await this.ctx.storage.put("lockout_until", lockoutUntil);
        result = {
          outcome: "locked",
          attempts,
          attempts_remaining: 0,
          lockout_until_ms: lockoutUntil,
        };
      } else {
        result = {
          outcome: "failed",
          attempts,
          attempts_remaining: MAX_ATTEMPTS - attempts,
          lockout_until_ms: null,
        };
      }
    }

    logLine({
      svc: "actor",
      route: "CustomerActor.attemptVerify",
      trace_id: args.traceId,
      customer_id: this.ctx.id,
      outcome: result.outcome,
      status: 200,
      duration_ms: Date.now() - t0,
    });
    return result;
  }

  /**
   * Demo reset: wipe all state. The next load() re-runs the lazy fixture seed,
   * so the seeded-open-case persona (C002) gets its case back automatically.
   * Only reachable via the admin route (secret-gated), never via the assistant.
   */
  async adminReset(traceId: string): Promise<{ reset: true }> {
    const KEYS = [
      "attempts",
      "lockout_until",
      "verified_call_id",
      "card_frozen",
      "card_frozen_reason",
      "card_frozen_at",
      "cases",
      "case_seq",
      "seeded",
    ];
    for (const k of KEYS) await this.ctx.storage.delete(k);
    logLine({
      svc: "actor",
      route: "CustomerActor.adminReset",
      trace_id: traceId,
      customer_id: this.ctx.id,
      outcome: "ok",
      status: 200,
      duration_ms: 0,
    });
    return { reset: true };
  }

  // ---- phase-2 secure actions -------------------------------------------------

  private isVerifiedFor(state: { verified_call_id: string | null }, callControlId: string): boolean {
    return !!callControlId && state.verified_call_id === callControlId;
  }

  async freezeCard(args: {
    callControlId: string;
    reason: string;
    traceId: string;
  }): Promise<{ status: FreezeCardStatus }> {
    const t0 = Date.now();
    const state = await this.load();
    let status: FreezeCardStatus;
    if (!this.isVerifiedFor(state, args.callControlId)) {
      status = VERIFIED_REQUIRED;
    } else if (state.card_frozen) {
      status = "already_frozen";
    } else {
      await this.ctx.storage.put("card_frozen", true);
      await this.ctx.storage.put("card_frozen_reason", args.reason);
      await this.ctx.storage.put("card_frozen_at", new Date().toISOString());
      status = "frozen";
    }
    logLine({
      svc: "actor",
      route: "CustomerActor.freezeCard",
      trace_id: args.traceId,
      customer_id: this.ctx.id,
      outcome: status === VERIFIED_REQUIRED ? "denied" : "ok",
      status: 200,
      duration_ms: Date.now() - t0,
    });
    return { status };
  }

  async openCase(args: {
    callControlId: string;
    category: string;
    amount_sgd?: number | null;
    summary: string;
    traceId: string;
  }): Promise<{ status: OpenCaseStatus; case_id: string | null }> {
    const t0 = Date.now();
    const state = await this.load();
    let status: OpenCaseStatus;
    let caseId: string | null = null;
    if (!this.isVerifiedFor(state, args.callControlId)) {
      status = VERIFIED_REQUIRED;
    } else {
      // Idempotent per call: one call opens at most one case — retries from the
      // same call_control_id return the case already opened by that call.
      const existing = state.cases.find((c) => c.opened_by_call === args.callControlId);
      if (existing) {
        status = "existing";
        caseId = existing.case_id;
      } else {
        const seq = state.case_seq + 1; // RMW under single-threaded dispatch
        await this.ctx.storage.put("case_seq", seq);
        caseId = `MB-${this.ctx.id}-${seq}`;
        state.cases.push({
          case_id: caseId,
          category: args.category,
          status: "open",
          amount_sgd: args.amount_sgd ?? null,
          summary: args.summary,
          opened_at: new Date().toISOString(),
          opened_by_call: args.callControlId,
        });
        await this.ctx.storage.put("cases", state.cases);
        status = "opened";
      }
    }
    logLine({
      svc: "actor",
      route: "CustomerActor.openCase",
      trace_id: args.traceId,
      customer_id: this.ctx.id,
      outcome: status === VERIFIED_REQUIRED ? "denied" : "ok",
      status: 200,
      duration_ms: Date.now() - t0,
    });
    return { status, case_id: caseId };
  }

  async getCases(args: {
    callControlId: string;
    traceId: string;
  }): Promise<{ status: GetCasesStatus; cases: Array<Pick<FraudCase, "case_id" | "category" | "status" | "opened_at">> }> {
    const t0 = Date.now();
    const state = await this.load();
    const ok = this.isVerifiedFor(state, args.callControlId);
    logLine({
      svc: "actor",
      route: "CustomerActor.getCases",
      trace_id: args.traceId,
      customer_id: this.ctx.id,
      outcome: ok ? "ok" : "denied",
      status: 200,
      duration_ms: Date.now() - t0,
    });
    if (!ok) return { status: VERIFIED_REQUIRED, cases: [] };
    return {
      status: "ok",
      cases: state.cases.map(({ case_id, category, status, opened_at }) => ({
        case_id,
        category,
        status,
        opened_at,
      })),
    };
  }
}
