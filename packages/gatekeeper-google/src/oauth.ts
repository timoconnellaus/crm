// Vendored from cloudflare/cloudflare-os@a3ba4746b58f packages/gatekeeper-google/src/oauth.ts (Apache-2.0). Modified locally: see UPSTREAM.md in this package.
import { stripTrailingSlashes } from "@relationship-os/gatekeeper-interface/gatekeeper";
import type { PreviewOAuthEnv } from "@relationship-os/gatekeeper-kit/preview-oauth";

const OAUTH_CALLBACK_PATH = "/oauth";

export type GoogleOAuthEnv = PreviewOAuthEnv & {
  BASE_URL?: string;
};

export function getBaseUrl(env: GoogleOAuthEnv): string {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/google");
}

export function getBasePath(env: GoogleOAuthEnv): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

export function getGoogleOAuthCallbackUri(env: GoogleOAuthEnv): string {
  return `${getBaseUrl(env)}${OAUTH_CALLBACK_PATH}`;
}
