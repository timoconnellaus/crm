// How a workspace reaches the hosted marketplace (ADR 0347). A hosted deployment signs each call on
// its control-plane channel (ADR 0250), so it needs nothing new and the marketplace is always there.
// A self-hosted one uses the workspace token it was given at setup: `ROS_MARKETPLACE_URL` and the
// secret `ROS_MARKETPLACE_TOKEN`. Neither set: this deployment has no marketplace.
import {
  MARKETPLACE_LISTINGS_PATH,
  MARKETPLACE_SUBMISSIONS_PATH,
  type MarketplaceClient,
  marketplaceListingResultSchema,
  marketplaceSearchResultSchema,
  marketplaceSubmissionResultSchema,
} from "@relationship-os/agent-plugins";
import { signDeploymentRequest } from "@relationship-os/release";

export interface MarketplaceEnv {
  ROS_CONTROL_URL?: string;
  ROS_CONTROL_KEY?: string;
  ROS_TENANT_ID?: string;
  ROS_MARKETPLACE_URL?: string;
  ROS_MARKETPLACE_TOKEN?: string;
}

const origin = (url: string | undefined) => url?.trim().replace(/\/+$/, "") ?? "";

export function marketplaceClientFor(
  env: MarketplaceEnv,
  options: { fetch?: typeof fetch } = {},
): MarketplaceClient | undefined {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const hosted = origin(env.ROS_CONTROL_URL);
  const key = env.ROS_CONTROL_KEY?.trim() ?? "";
  const tenant = env.ROS_TENANT_ID?.trim() ?? "";
  const own = origin(env.ROS_MARKETPLACE_URL);
  const token = env.ROS_MARKETPLACE_TOKEN?.trim() ?? "";
  const signed = Boolean(hosted && key && tenant);
  if (!signed && !(own && token)) return undefined;
  const base = signed ? hosted : own;

  const send = async (method: "GET" | "POST", path: string, query = "", body = "") => {
    const auth = signed
      ? await signDeploymentRequest({ key, tenant, method, path, body })
      : { authorization: `Bearer ${token}` };
    return doFetch(`${base}${path}${query}`, {
      method,
      headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body } : {}),
    });
  };

  const fail = (response: Response) =>
    new Error(`The marketplace answered ${response.status}`);

  return {
    async search(input) {
      const query = input.query ? `?q=${encodeURIComponent(input.query)}` : "";
      const response = await send("GET", MARKETPLACE_LISTINGS_PATH, query);
      if (!response.ok) throw fail(response);
      return marketplaceSearchResultSchema.parse(await response.json());
    },
    async get(id) {
      const response = await send(
        "GET",
        `${MARKETPLACE_LISTINGS_PATH}/${encodeURIComponent(id)}`,
      );
      if (response.status === 404) return null;
      if (!response.ok) throw fail(response);
      return marketplaceListingResultSchema.parse(await response.json());
    },
    async submit(submission) {
      const response = await send(
        "POST",
        MARKETPLACE_SUBMISSIONS_PATH,
        "",
        JSON.stringify(submission),
      );
      if (!response.ok) throw fail(response);
      return marketplaceSubmissionResultSchema.parse(await response.json());
    },
    async submission(id) {
      const response = await send(
        "GET",
        `${MARKETPLACE_SUBMISSIONS_PATH}/${encodeURIComponent(id)}`,
      );
      if (response.status === 404) return null;
      if (!response.ok) throw fail(response);
      return marketplaceSubmissionResultSchema.parse(await response.json());
    },
  };
}
