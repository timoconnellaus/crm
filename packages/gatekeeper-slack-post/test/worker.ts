// The test Worker: the real gatekeeper Worker plus a host-like harness standing in for the CRM's
// integration host (the Workshop side) and a fake Workshop connect callback.

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription,
  ActionKind,
  ConnectHandoff,
  GatekeeperConnectCallback,
  GatekeeperUser,
  ObservationDescription,
  ResourceDescription,
} from "@relationship-os/gatekeeper-interface/gatekeeper";
import type { SlackPostSession } from "../src/types";
import type { SlackPostGatekeeper } from "../src/worker";
import { callbackLog, nextHandoff } from "./fake-slack";

// Named one by one: the Workers pool derives ctx.exports from the main module's own export names,
// and does not follow `export *`.
export {
  default,
  GatekeeperVendor,
  SlackPostAccount,
  SlackPostGatekeeper,
  SlackPostUserAccount,
  SlackPostVerifier,
} from "../src/worker";

/** Every action and observation the fake approval queue received. */
export const submissions: [number, ActionDescription][] = [];
export const observations: ObservationDescription[] = [];

/** Stands in for the Workshop's GatekeeperConnectCallback. */
export class FakeConnectCallback extends WorkerEntrypoint {
  async complete(user: Fetcher<GatekeeperUser>, _expiresAt?: Date): Promise<ConnectHandoff> {
    // The RPC stub type of a Fetcher<GatekeeperUser> collapses; the account is a SlackPostAccount.
    const account = user as unknown as {
      describe(): Promise<{ displayName?: string; uniqueName?: string }>;
    };
    const { displayName, uniqueName } = await account.describe();
    callbackLog.push({
      kind: "complete",
      account: {
        ...(displayName !== undefined ? { displayName } : {}),
        ...(uniqueName !== undefined ? { uniqueName } : {}),
      },
    });
    return nextHandoff();
  }

  async reconnectComplete(stageId: string, _expiresAt?: Date): Promise<ConnectHandoff> {
    callbackLog.push({ kind: "reconnect", stageId });
    return nextHandoff();
  }

  async credentialsExpired(): Promise<void> {
    callbackLog.push({ kind: "expired" });
  }

  async credentialsRestored(_expiresAt?: Date): Promise<void> {}
}

class FakeQueue extends RpcTarget {
  async submitAction(action: number, description: ActionDescription): Promise<void> {
    submissions.push([action, description]);
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    observations.push(description);
  }
}

type SessionMethod = keyof SlackPostSession;
type AccountMethod =
  | "describe"
  | "getSupportedResources"
  | "getGatekeeperClassFor"
  | "startResourceConfigurator"
  | "reconnect"
  | "commitReconnect"
  | "ensureResources"
  | "revoke";

type Callable = Record<string, (...args: unknown[]) => Promise<unknown>>;

/** The host side: starts connects, owns the facet, as the CRM's integration host DO does. */
export class TestHost extends DurableObject<Cloudflare.Env> {
  #facet: Fetcher<SlackPostGatekeeper> | undefined;
  #session: SlackPostSession | undefined;

  /** Starts a connect with the fake Workshop callback; returns the connect URL. */
  async startConnect(resourceUrlPatterns?: string[]): Promise<string> {
    // FakeConnectCallback is a test-only export, so the generated Exports type lacks it.
    const testExports = this.ctx.exports as unknown as {
      FakeConnectCallback(options: object): Fetcher<GatekeeperConnectCallback>;
    };
    const { url } = await this.ctx.exports.GatekeeperVendor.connectAccount(
      testExports.FakeConnectCallback({}),
      resourceUrlPatterns === undefined ? undefined : { resourceUrlPatterns },
    );
    return url;
  }

  /** Calls a GatekeeperUser method on the account. */
  async account(accountId: string, method: AccountMethod, args: unknown[] = []): Promise<unknown> {
    const account = this.ctx.exports.SlackPostAccount({
      props: { accountId },
    }) as unknown as Callable;
    const result = await account[method]?.(...args);
    // A configurator frame carries a live stub; return its workspace() answer instead.
    if (method === "startResourceConfigurator") {
      const frame = result as { iframeHtml: string; ui: Callable };
      return { iframeHtml: frame.iframeHtml, workspace: await frame.ui.workspace?.() };
    }
    return result;
  }

  /** Resolves `url` through the account, creates the facet and opens a session. */
  async open(accountId: string, url: string): Promise<ResourceDescription> {
    const account = this.ctx.exports.SlackPostAccount({ props: { accountId } });
    const { class: gatekeeperClass } = await account.getGatekeeperClassFor(url);
    const facet = this.ctx.facets.get<SlackPostGatekeeper>("gatekeeper", () => ({
      // The class crosses RPC as an opaque DurableObjectClass; its interface is the facet's.
      class: gatekeeperClass as unknown as DurableObjectClass<SlackPostGatekeeper>,
    }));
    this.#facet = facet;
    this.#session = (await facet.startSession(
      new FakeQueue() as never,
    )) as unknown as SlackPostSession;
    return facet.describe();
  }

  /** Calls a session method with arguments that may be anything, as extension code can. */
  async call(method: SessionMethod, args: unknown[]): Promise<unknown> {
    const session = this.#requireSession() as unknown as Callable;
    // Called as a method: `.apply` on an RPC stub would itself be an RPC call.
    return session[method]?.(...args);
  }

  async apply(id: number): Promise<void> {
    await this.#requireFacet().applyAction(id);
  }

  async reject(id: number): Promise<void> {
    await this.#requireFacet().rejectAction(id);
  }

  async autoApprovable(): Promise<ActionKind[]> {
    return this.#requireFacet().getAutoApprovableActions();
  }

  #requireFacet(): Fetcher<SlackPostGatekeeper> {
    if (!this.#facet) throw new Error("open() first");
    return this.#facet;
  }

  #requireSession(): SlackPostSession {
    if (!this.#session) throw new Error("open() first");
    return this.#session;
  }
}
