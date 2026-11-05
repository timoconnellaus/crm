// Hashes used by release bundles (ADR 0160). Web Crypto only, so the CLI (Node) and the
// self-updater (Workers) compute them the same way.
//
// Two schemes, as in Cloudflare OS's release tooling:
// - Worker modules, migrations and the bundle itself are addressed by full SHA-256 (hex).
// - Static assets use the key the Workers assets-upload session takes: SHA-256 of
//   (base64(contents) + extension), hex, truncated to 32 characters. The API treats it as an
//   opaque per-file key, so the build and the deployer only have to agree on it.

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return toHex(new Uint8Array(digest));
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}

/** The Workers static-asset content key of a file at `path` (see header). */
export async function assetHash(bytes: Uint8Array, path: string): Promise<string> {
  return (await sha256Hex(toBase64(bytes) + extensionOf(path))).slice(0, 32);
}

/** Constant-time-ish string compare for digests (they are public, but keep the habit). */
export function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
