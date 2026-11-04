// Cloudflare Access adapter: Access authenticates the user before the request reaches the Worker
// and forwards a signed JWT. We verify it against the team's JWKS, issuer and the app's AUD tag.
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { IdentityProvider, Principal } from "./principal.ts";

export interface CloudflareAccessOptions {
  /** CF_ACCESS_TEAM_DOMAIN: `myteam`, `myteam.cloudflareaccess.com` or its https URL. */
  teamDomain: string;
  /** CF_ACCESS_AUD: the Application Audience (AUD) tag of the Access application. */
  audience: string;
  /** Key source override for tests. Defaults to the team's published certs. */
  jwks?: JWTVerifyGetKey;
}

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
const ACCESS_COOKIE = "CF_Authorization";

export function normaliseTeamDomain(teamDomain: string): string {
  let host = teamDomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!host.includes(".")) host = `${host}.cloudflareaccess.com`;
  return `https://${host}`;
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function readToken(request: Request): string | null {
  const header = request.headers.get(ACCESS_JWT_HEADER);
  if (header) return header;
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ACCESS_COOKIE) return rest.join("=");
  }
  return null;
}

export function cloudflareAccessProvider(options: CloudflareAccessOptions): IdentityProvider {
  const issuer = normaliseTeamDomain(options.teamDomain);
  const jwks =
    options.jwks ??
    remoteKeySets.get(issuer) ??
    createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  if (!options.jwks) remoteKeySets.set(issuer, jwks);

  return {
    kind: "cloudflare-access",
    signInPath: null,
    signOutUrl: "/cdn-cgi/access/logout",
    async resolve(request): Promise<Principal | null> {
      const token = readToken(request);
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer,
          audience: options.audience,
          algorithms: ["RS256"],
        });
        const email = typeof payload.email === "string" ? payload.email : null;
        // Service tokens carry no email; they are not users and are not admitted in stage 0.
        if (!payload.sub || !email) return null;
        const name = typeof payload.name === "string" && payload.name ? payload.name : email;
        return { userId: payload.sub, email, name, roles: [] };
      } catch {
        return null;
      }
    },
  };
}
