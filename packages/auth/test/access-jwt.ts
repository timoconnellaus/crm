// Test helpers: a throwaway RSA key pair standing in for an Access team's signing key.
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

export const TEAM = "https://crm-test.cloudflareaccess.com";
export const AUD = "test-aud-tag";

export async function createAccessKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  return {
    jwks: { keys: [jwk] },
    sign(
      claims: Record<string, unknown>,
      options: { issuer?: string; audience?: string; expiresIn?: string } = {},
    ) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(options.issuer ?? TEAM)
        .setAudience(options.audience ?? AUD)
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? "5m")
        .sign(privateKey);
    },
  };
}
