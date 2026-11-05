// The test Worker: the real gatekeeper Worker plus a host-like harness standing in for the CRM's
// integration host (the Workshop side), and a fake Email Service binding (vitest.config.ts binds
// EMAIL to FakeEmail).

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription,
  ActionKind,
  ObservationDescription,
  ResourceDescription,
} from "@relationship-os/gatekeeper-interface/gatekeeper";
import type { OutgoingEmail } from "../src/transport";
import type { EmailSendSession } from "../src/types";
import type { EmailSendGatekeeper } from "../src/worker";
import { fakeEmail, observations, sentEmails, submissions } from "./fakes";

// Named one by one: the Workers pool derives ctx.exports from the main module's own export names,
// and does not follow `export *`.
export {
  default,
  EmailSendAccount,
  EmailSendGatekeeper,
  EmailSendVerifier,
  GatekeeperVendor,
} from "../src/worker";

/** Stands in for Email Service's `send_email` binding. */
export class FakeEmail extends WorkerEntrypoint {
  async send(message: OutgoingEmail): Promise<{ messageId: string }> {
    if (fakeEmail.failNext) {
      fakeEmail.failNext = false;
      throw new Error("connection reset while sending");
    }
    sentEmails.push(message);
    return { messageId: `msg-${sentEmails.length}` };
  }
}

/**
 * Stands in for the overseer's approval queue. With `autoApply`, it applies an auto-approvable
 * action while the submission is still in flight, as a host with that kind enabled may.
 */
class FakeQueue extends RpcTarget {
  readonly #autoApply: ((id: number) => Promise<void>) | undefined;

  constructor(autoApply?: (id: number) => Promise<void>) {
    super();
    this.#autoApply = autoApply;
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    submissions.push([action, description]);
    if (description.autoApprovable === true && this.#autoApply) await this.#autoApply(action);
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    observations.push(description);
  }
}

type SessionMethod = keyof EmailSendSession;

/** The host side: owns the facet, as the CRM's integration host DO does. */
export class TestHost extends DurableObject<Cloudflare.Env> {
  #facet: Fetcher<EmailSendGatekeeper> | undefined;
  #session: EmailSendSession | undefined;

  /** Resolves `url` through a fresh account, creates the facet and opens a session. */
  async open(url: string, options: { autoApply?: boolean } = {}): Promise<ResourceDescription> {
    const account = this.ctx.exports.EmailSendAccount({});
    const { class: gatekeeperClass } = await account.getGatekeeperClassFor(url);
    const facet = this.ctx.facets.get<EmailSendGatekeeper>("gatekeeper", () => ({
      // The class crosses RPC as an opaque DurableObjectClass; its interface is the facet's.
      class: gatekeeperClass as unknown as DurableObjectClass<EmailSendGatekeeper>,
    }));
    this.#facet = facet;
    const queue = new FakeQueue(options.autoApply ? (id) => facet.applyAction(id) : undefined);
    this.#session = (await facet.startSession(queue as never)) as unknown as EmailSendSession;
    return facet.describe();
  }

  /** Calls a session method with arguments that may be anything, as extension code can. */
  async call(method: SessionMethod, args: unknown[]): Promise<unknown> {
    const session = this.#requireSession() as unknown as Record<
      SessionMethod,
      (...args: unknown[]) => Promise<unknown>
    >;
    // Called as a method: `.apply` on an RPC stub would itself be an RPC call.
    return session[method](...args);
  }

  async apply(id: number): Promise<void> {
    await this.#requireFacet().applyAction(id);
  }

  async reject(id: number): Promise<void> {
    await this.#requireFacet().rejectAction(id);
  }

  async revert(id: number): Promise<unknown> {
    return this.#requireFacet().revertAction(id);
  }

  async autoApprovable(): Promise<ActionKind[]> {
    return this.#requireFacet().getAutoApprovableActions();
  }

  async types(): Promise<string> {
    return this.#requireFacet().getTypeScriptTypes();
  }

  #requireFacet(): Fetcher<EmailSendGatekeeper> {
    if (!this.#facet) throw new Error("open() first");
    return this.#facet;
  }

  #requireSession(): EmailSendSession {
    if (!this.#session) throw new Error("open() first");
    return this.#session;
  }
}
