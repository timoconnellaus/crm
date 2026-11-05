// Full Sigstore verification with the GitHub CLI (`gh attestation verify`), when `gh` is
// installed: certificate chain to Sigstore's root, transparency log, and the signer workflow at
// this version's tag. The library's own check (GitHub's attestation store) always runs too.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ExtraVerifier, releaseAssetNames, VerificationError } from "@relationship-os/release";

const run = promisify(execFile);

export async function ghAvailable(): Promise<boolean> {
  try {
    await run("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export const ghVerifier: ExtraVerifier = async ({ bytes, repository, version }) => {
  const dir = await mkdtemp(join(tmpdir(), "ros-verify-"));
  const file = join(dir, releaseAssetNames(version).bundle);
  try {
    await writeFile(file, bytes);
    await run("gh", [
      "attestation",
      "verify",
      file,
      "--repo",
      repository,
      "--signer-workflow",
      `${repository}/.github/workflows/release.yml`,
      "--source-ref",
      `refs/tags/v${version}`,
      "--deny-self-hosted-runners",
    ]);
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
    throw new VerificationError(`gh attestation verify failed: ${detail}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
