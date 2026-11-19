import { StatefulActor } from "@telnyx/edge-runtime";

export class Counter extends StatefulActor {
  async increment(): Promise<number> {
    const current = (await this.ctx.storage.get<number>("value")) ?? 0;
    const next = current + 1;
    await this.ctx.storage.put("value", next);
    return next;
  }

  async value(): Promise<number> {
    return (await this.ctx.storage.get<number>("value")) ?? 0;
  }
}
