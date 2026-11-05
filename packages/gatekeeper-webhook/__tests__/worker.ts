// Test worker: the production entrypoints, plus a stand-in for the CRM's integration host.
//
// `TestHost` has to be a Durable Object: a `DurableObjectClass` is only reachable through
// `ctx.facets`, which is how the host instantiates a gatekeeper, and a stub to a facet or to a
// session it mints cannot be handed to the test. So TestHost runs each scenario itself and returns
// plain data.

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ObservationDescription } from "@relationship-os/gatekeeper-interface/gatekeeper";
import type { WebhookEvent, WebhookSession } from "../src/types.js";

// Named one by one: the pool registers a main module's entrypoints in `ctx.exports` only when they
// are exported by name, not through `export *`.
export {
  default,
  GatekeeperVendor,
  WebhookAccount,
  WebhookEndpoint,
  WebhookEndpointGatekeeper,
  WebhookHookController,
  WebhookVerifier,
} from "../src/worker.js";

/** Events each test hook received, by the key its initiator was minted with. */
const received = new Map<string, WebhookEvent[]>();
/** Observations each firing's approval queue recorded, by key. */
const firingObservations = new Map<string, ObservationDescription[]>();
/** Deliveries to fail before succeeding, by key. */
const failures = new Map<string, number>();

/** The callback a hook firing reaches: records each event. */
class RecordingHook extends RpcTarget {
  readonly #key: string;

  constructor(key: string) {
    super();
    this.#key = key;
  }

  async receiveEvent(event: WebhookEvent): Promise<void> {
    const failing = failures.get(this.#key) ?? 0;
    if (failing > 0) {
      failures.set(this.#key, failing - 1);
      throw new Error("test hook failure");
    }
    const events = received.get(this.#key) ?? [];
    events.push(event);
    received.set(this.#key, events);
  }
}

type Controller = {
  enable(initiator: unknown, target: unknown): Promise<void>;
  disable(): Promise<void>;
};

/** A fake ApprovalQueue: records observations and the hooks bound through it. */
class RecordingQueue extends RpcTarget {
  readonly observations: ObservationDescription[] = [];
  readonly hooks: { title: string; description: string }[] = [];
  readonly controllers: Controller[] = [];
  readonly #onObservation: ((description: ObservationDescription) => void) | undefined;

  constructor(onObservation?: (description: ObservationDescription) => void) {
    super();
    this.#onObservation = onObservation;
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
    this.#onObservation?.(description);
  }

  async submitAction(): Promise<void> {
    throw new Error("The webhook gatekeeper has no actions.");
  }

  async bindHook(
    controller: Controller,
    _callback: unknown,
    description: { title: string; description: string },
  ): Promise<void> {
    this.controllers.push(controller);
    this.hooks.push(description);
  }
}

/** The host's side of a hook firing: a fresh queue and the hook the agent bound. */
export class TestInitiator extends WorkerEntrypoint<Cloudflare.Env, { key: string }> {
  async startHook(): Promise<{ callback: RecordingHook; approvalQueue: RecordingQueue }> {
    const { key } = this.ctx.props;
    return {
      callback: new RecordingHook(key),
      approvalQueue: new RecordingQueue((description) => {
        const list = firingObservations.get(key) ?? [];
        list.push(description);
        firingObservations.set(key, list);
      }),
    };
  }
}

type Account = {
  getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass }>;
};

type Facet = {
  describe(): Promise<unknown>;
  startSession(queue: RecordingQueue): Promise<WebhookSession & Partial<Disposable>>;
};

type TestExports = {
  WebhookAccount(options: object): Account;
  TestInitiator(options: { props: { key: string } }): Fetcher;
};

export class TestHost extends DurableObject<Cloudflare.Env> {
  readonly #queues = new Map<string, RecordingQueue>();

  get #exports(): TestExports {
    return this.ctx.exports as unknown as TestExports;
  }

  /** The endpoint's gatekeeper facet, from the class the account hands out for its URL. */
  async #facet(endpointId: string): Promise<Facet> {
    const account = this.#exports.WebhookAccount({});
    const { class: cls } = await account.getGatekeeperClassFor(`webhook://endpoint/${endpointId}`);
    return this.ctx.facets.get(`endpoint-${endpointId}`, () => ({
      class: cls,
    })) as unknown as Facet;
  }

  #queue(endpointId: string): RecordingQueue {
    const existing = this.#queues.get(endpointId);
    if (existing) return existing;
    const queue = new RecordingQueue();
    this.#queues.set(endpointId, queue);
    return queue;
  }

  async describe(endpointId: string): Promise<unknown> {
    return (await this.#facet(endpointId)).describe();
  }

  /** Opens a session, calls `method` on it, and returns the result and what the queue saw. */
  async call(
    endpointId: string,
    method: "getEndpoint" | "listEvents",
    ...args: unknown[]
  ): Promise<{ result?: unknown; error?: string; observations: ObservationDescription[] }> {
    const queue = this.#queue(endpointId);
    const session = await (await this.#facet(endpointId)).startSession(queue);
    try {
      // Called as a method: `.apply` on an RPC stub would itself be an RPC call.
      const callable = session as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      return { result: await callable[method]?.(...args), observations: queue.observations };
    } catch (error) {
      return { error: String(error), observations: queue.observations };
    } finally {
      session[Symbol.dispose]?.();
    }
  }

  /**
   * The host's half of binding a hook: the session subscribes (bindHook records the controller),
   * then, as if a human approved, the host enables the controller with its own initiator.
   */
  async bindAndEnable(
    endpointId: string,
    key: string,
  ): Promise<{ title: string; description: string }> {
    const queue = this.#queue(endpointId);
    const session = await (await this.#facet(endpointId)).startSession(queue);
    try {
      await session.subscribe(new RecordingHook(key));
    } finally {
      session[Symbol.dispose]?.();
    }
    const controller = queue.controllers.at(-1);
    const hook = queue.hooks.at(-1);
    if (!controller || !hook) throw new Error("subscribe() did not bind a hook");
    const initiator = this.#exports.TestInitiator({ props: { key } });
    await controller.enable(initiator, { workspaceId: "workspace-1" });
    return hook;
  }

  /** Disables the most recent hook bound for the endpoint. */
  async disable(endpointId: string): Promise<void> {
    const controller = this.#queue(endpointId).controllers.at(-1);
    if (!controller) throw new Error("no hook bound");
    await controller.disable();
  }

  async received(
    key: string,
  ): Promise<{ events: WebhookEvent[]; observations: ObservationDescription[] }> {
    return { events: received.get(key) ?? [], observations: firingObservations.get(key) ?? [] };
  }

  async failNext(key: string, count: number): Promise<void> {
    failures.set(key, count);
  }
}
