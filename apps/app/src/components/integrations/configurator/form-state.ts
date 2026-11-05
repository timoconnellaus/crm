// The configurator form's state rules, kept pure so they can be tested without a DOM.
import type {
  ConfiguratorUIHostContext,
  ConfiguratorUISpec,
  ConfiguratorUIValues,
} from "@relationship-os/gatekeeper-configurator-ui";

/** `setValues(patch)`: the patch merged over the values. An empty patch only re-renders. */
export function applySetValues(
  values: ConfiguratorUIValues,
  patch: Partial<ConfiguratorUIValues>,
): ConfiguratorUIValues {
  return { ...values, ...patch };
}

/** `clearFields(...names)`: those values dropped (their controls also start afresh). */
export function applyClearFields(
  values: ConfiguratorUIValues,
  names: readonly string[],
): ConfiguratorUIValues {
  const next = { ...values };
  for (const name of names) delete next[name];
  return next;
}

/**
 * The runtime's fallback for a spec without `initialValuesFromResourceUrl`: the URLPattern named
 * groups `resourceUrl` matches in `resourceUrlPattern`, decoded, so a value keyed like its group
 * (`:areaId` -> `areaId`) opens pre-filled. Wildcard groups (numbered) are skipped. Empty when
 * the URL does not match or the platform has no URLPattern.
 */
export function valuesFromPatternGroups(
  resourceUrlPattern: string,
  resourceUrl: string,
): ConfiguratorUIValues {
  if (typeof URLPattern === "undefined") return {};
  let result: URLPatternResult | null;
  try {
    result = new URLPattern(resourceUrlPattern).exec(resourceUrl);
  } catch {
    return {};
  }
  if (!result) return {};
  const values: ConfiguratorUIValues = {};
  const components = [
    result.protocol,
    result.username,
    result.password,
    result.hostname,
    result.port,
    result.pathname,
    result.search,
    result.hash,
  ];
  for (const component of components) {
    for (const [name, value] of Object.entries(component.groups)) {
      if (/^\d+$/.test(name) || value === undefined || value === "") continue;
      values[name] = safeDecode(value);
    }
  }
  return values;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The values a form opens with: the spec's `initial`, then what the resource URL gives. */
export async function initialValuesFor(
  spec: ConfiguratorUISpec<unknown>,
  options: ConfiguratorUIHostContext & {
    ui: unknown;
    resourceUrlPattern: string;
    resourceUrl?: string | null;
  },
): Promise<ConfiguratorUIValues> {
  const initial = { ...spec.initial };
  const { resourceUrl, resourceUrlPattern, ui, acceptedResourceUrlPatterns } = options;
  if (!resourceUrl) return initial;
  const derived = spec.initialValuesFromResourceUrl
    ? await spec.initialValuesFromResourceUrl({
        resourceUrl,
        resourceUrlPattern,
        ui,
        ...(acceptedResourceUrlPatterns ? { acceptedResourceUrlPatterns } : {}),
      })
    : valuesFromPatternGroups(resourceUrlPattern, resourceUrl);
  return { ...initial, ...derived };
}

/**
 * Whether the form may be submitted: the spec's `isReady` when it has one, otherwise once a render
 * has succeeded. Never ready while the render fails.
 */
export function readiness(
  spec: ConfiguratorUISpec<unknown>,
  state: ConfiguratorUIHostContext & {
    values: ConfiguratorUIValues;
    rendered: boolean;
    renderFailed: boolean;
  },
): boolean {
  if (state.renderFailed) return false;
  if (!spec.isReady) return state.rendered;
  try {
    return Boolean(
      spec.isReady({
        values: state.values,
        ...(state.acceptedResourceUrlPatterns
          ? { acceptedResourceUrlPatterns: state.acceptedResourceUrlPatterns }
          : {}),
      }),
    );
  } catch {
    return false;
  }
}

/** A thrown value as a message for the user. */
export function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}
