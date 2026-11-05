// The IntegrationRuntime port (packages/core integrations/runtime.ts) as ros-runner implements it:
// every call goes to the connection's own integration host Durable Object (ADR 0110). ros-app
// reaches the same methods over RPC (the Runner entrypoint).
import {
  CATALOGUE,
  type IntegrationRuntime,
  OperationError,
  vendorBinding,
} from "@relationship-os/core";

export function hostFor(env: Env, connectionId: string) {
  return env.INTEGRATION_HOST.getByName(connectionId);
}

/** Vendors with a GATEKEEPER_<NAME> binding here (the fake one only when turned on). */
export function availableVendors(env: Env): string[] {
  const bindings = env as unknown as Record<string, unknown>;
  return CATALOGUE.filter((entry) => {
    if (entry.vendor === "fake" && env.INTEGRATIONS_FAKE_PROVIDER !== "true") return false;
    return Boolean(bindings[vendorBinding(entry.vendor)]);
  }).map((entry) => entry.vendor);
}

/** A gatekeeper or host failure, as a typed error the caller sees (not "Internal error"). */
function typed<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof OperationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new OperationError("integration_error", message.slice(0, 2000));
    }
  };
}

export function integrationRuntime(env: Env): IntegrationRuntime {
  const runtime: IntegrationRuntime = {
    availableVendors: async () => availableVendors(env),
    startConnect: (i) =>
      hostFor(env, i.connectionId).startConnect({
        vendor: i.vendor,
        userId: i.userId,
        ...(i.appOrigin ? { appOrigin: i.appOrigin } : {}),
      }),
    provision: (i) =>
      hostFor(env, i.connectionId).provision({ vendor: i.vendor, userId: i.userId }),
    redeem: (i) =>
      hostFor(env, i.connectionId).redeem({ ticket: i.ticket, nonce: i.nonce, userId: i.userId }),
    reconnect: (i) =>
      hostFor(env, i.connectionId).reconnect({
        userId: i.userId,
        ...(i.appOrigin ? { appOrigin: i.appOrigin } : {}),
      }),
    disconnect: (i) => hostFor(env, i.connectionId).disconnect(),
    bindResource: (i) => hostFor(env, i.connectionId).bindResource(i.url),
    unbindResource: (i) => hostFor(env, i.connectionId).unbindResource(i.key),
    supportedResources: (i) => hostFor(env, i.connectionId).supportedResources(),
    configure: (i) => hostFor(env, i.connectionId).configure(i.pattern, i.method, i.args),
    call: (i) =>
      hostFor(env, i.connectionId).call({
        resource: i.resource,
        method: i.method,
        args: i.args,
        caller: i.caller,
      }),
    types: (i) => hostFor(env, i.connectionId).types(i.resource),
    applyOutbound: (i) => hostFor(env, i.connectionId).applyOutbound(i.facetKey, i.action),
    rejectOutbound: (i) => hostFor(env, i.connectionId).rejectOutbound(i.facetKey, i.action),
    setSync: (i) => hostFor(env, i.connectionId).setSync(i.config),
    syncNow: (i) => hostFor(env, i.connectionId).syncNow(),
  };
  return Object.fromEntries(
    Object.entries(runtime).map(([name, fn]) => [
      name,
      typed(fn as (i: unknown) => Promise<unknown>),
    ]),
  ) as unknown as IntegrationRuntime;
}

/** R2 for email bodies (ADR 0112). */
export function blobStore(env: Env) {
  const bucket = env.BLOBS;
  if (!bucket) return undefined;
  return {
    get: async (key: string) => (await bucket.get(key))?.text() ?? null,
    put: async (key: string, value: string) => {
      await bucket.put(key, value);
    },
    delete: async (keys: string[]) => {
      if (keys.length) await bucket.delete(keys);
    },
  };
}
