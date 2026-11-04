// The `ui` capability a configurator spec calls, in the browser: every method call becomes one call
// through the server, which holds the gatekeeper's real `ui` stub.

/** Sends one `ui` method call to the server and resolves with its result. */
export type UiCall = (method: string, args: unknown[]) => Promise<unknown>;

/**
 * An object on which `ui.someMethod(a, b)` is `call("someMethod", [a, b])`. It is not a thenable
 * (`then` is undefined), so it can be returned from async functions and awaited safely, and it
 * offers no other properties: symbols and `toJSON` are undefined too.
 */
export function uiProxy(call: UiCall): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const methods = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return new Proxy(
    Object.create(null) as Record<string, (...args: unknown[]) => Promise<unknown>>,
    {
      get(_target, property) {
        if (typeof property !== "string" || property === "then" || property === "toJSON") {
          return undefined;
        }
        let method = methods.get(property);
        if (!method) {
          method = (...args: unknown[]) => call(property, args);
          methods.set(property, method);
        }
        return method;
      },
      has(_target, property) {
        return typeof property === "string" && property !== "then" && property !== "toJSON";
      },
      set() {
        return false;
      },
    },
  );
}
