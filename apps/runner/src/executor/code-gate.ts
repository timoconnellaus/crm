// Code Mode's per-user concurrency limit (ADR 0043): one small Durable Object per user
// (getByName(userId)) holding at most one lease. A lease expires on its own after the script's
// timeout plus a margin, so a crashed caller cannot lock a user out. The DO does no other work and
// is idle (hibernated) between runs. The rate limit is separate: the Workers Rate Limiting binding
// in crm-app (CODE_MODE_RATE_LIMIT).
import { DurableObject } from "cloudflare:workers";

interface Lease {
  token: string;
  until: number;
}

export class CodeModeGate extends DurableObject<Env> {
  /** A lease token, or null while another run of this user holds an unexpired lease. */
  async acquire(ttlMs: number): Promise<string | null> {
    const now = Date.now();
    const held = await this.ctx.storage.get<Lease>("lease");
    if (held && held.until > now) return null;
    const token = crypto.randomUUID();
    await this.ctx.storage.put("lease", { token, until: now + ttlMs } satisfies Lease);
    return token;
  }

  async release(token: string): Promise<void> {
    const held = await this.ctx.storage.get<Lease>("lease");
    if (held?.token === token) await this.ctx.storage.delete("lease");
  }
}
