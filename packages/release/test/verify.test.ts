// Attestation verification (AC2): a genuine release verifies; a tampered bundle is refused
// whether or not the attacker also rewrote SHA256SUMS; attestations from another workflow, ref
// or repository do not count.
import { describe, expect, it } from "vitest";
import { fetchVerifiedRelease, listReleases, VerificationError } from "../src/index.ts";
import { buildFixtureRelease, FakeGitHub } from "../src/testing/index.ts";

function options(github: FakeGitHub) {
  return { apiBase: github.api, fetch: github.fetch, repository: github.repository };
}

describe("release verification", () => {
  it("accepts a release with a matching digest and attestation", async () => {
    const github = new FakeGitHub();
    const release = await buildFixtureRelease({ version: "1.0.0" });
    await github.publish(release);
    const verified = await fetchVerifiedRelease("1.0.0", options(github));
    expect(verified.digest).toBe(release.digest);
    expect(verified.bundle.manifest.version).toBe("1.0.0");
  });

  it("refuses a swapped bundle (SHA256SUMS mismatch)", async () => {
    const github = new FakeGitHub();
    const release = await buildFixtureRelease({ version: "1.0.0" });
    const other = await buildFixtureRelease({ version: "1.0.0", gatekeeperRevision: 666 });
    await github.publish(release, { tamper: { bytes: other.bundle } });
    await expect(fetchVerifiedRelease("1.0.0", options(github))).rejects.toThrow(
      /changed after it was built/,
    );
  });

  it("refuses a swapped bundle even with rewritten SHA256SUMS (no attestation)", async () => {
    const github = new FakeGitHub();
    const release = await buildFixtureRelease({ version: "1.0.0" });
    const other = await buildFixtureRelease({ version: "1.0.0", gatekeeperRevision: 666 });
    await github.publish(release, { tamper: { bytes: other.bundle, rewriteSums: true } });
    await expect(fetchVerifiedRelease("1.0.0", options(github))).rejects.toThrow(VerificationError);
  });

  it("refuses attestations from another workflow, ref or repository", async () => {
    for (const workflow of [
      { path: ".github/workflows/ci.yml" },
      { ref: "refs/heads/main" },
      { repository: "https://github.com/someone/fork" },
    ]) {
      const github = new FakeGitHub();
      await github.publish(await buildFixtureRelease({ version: "1.0.0" }), { workflow });
      await expect(fetchVerifiedRelease("1.0.0", options(github))).rejects.toThrow(
        /no valid build attestation/,
      );
    }
  });

  it("lists releases per channel, newest first, skipping drafts", async () => {
    const github = new FakeGitHub();
    await github.publish(await buildFixtureRelease({ version: "1.0.0" }));
    await github.publish(await buildFixtureRelease({ version: "1.1.0-beta.1" }));
    await github.publish(await buildFixtureRelease({ version: "1.1.0" }), { draft: true });
    const stable = await listReleases("stable", options(github));
    const beta = await listReleases("beta", options(github));
    expect(stable.map((r) => r.version)).toEqual(["1.0.0"]);
    expect(beta.map((r) => r.version)).toEqual(["1.1.0-beta.1", "1.0.0"]);
  });
});
