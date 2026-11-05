import { describe, expect, it } from "vitest";
import {
  assertUnresolved,
  BundleError,
  channelOf,
  compareVersions,
  deployOrder,
  durableObjectMigration,
  gunzip,
  gzip,
  openBundle,
  readTar,
  renderBindings,
  renderString,
  sha256Hex,
  snappyDecompress,
  visibleOnChannel,
  writeTar,
} from "../src/index.ts";
import { buildFixtureRelease } from "../src/testing/index.ts";

const values = {
  accountId: "acc",
  hostname: "crm.example.com",
  workerName: (n: string) => `x-${n}`,
  resource: (kind: string, name: string) => `${kind}:${name}`,
  secret: (n: string) => (n === "KNOWN" ? "s3cret" : undefined),
};

describe("semver and channels", () => {
  it("orders betas before their release", () => {
    const versions = ["1.0.0", "1.0.0-beta.2", "0.9.9", "1.0.0-beta.10", "1.0.1"];
    expect([...versions].sort(compareVersions)).toEqual([
      "0.9.9",
      "1.0.0-beta.2",
      "1.0.0-beta.10",
      "1.0.0",
      "1.0.1",
    ]);
  });

  it("a stable deployment never sees betas; a beta deployment sees both", () => {
    expect(channelOf("1.2.0-beta.1")).toBe("beta");
    expect(visibleOnChannel("1.2.0-beta.1", "stable")).toBe(false);
    expect(visibleOnChannel("1.2.0-beta.1", "beta")).toBe(true);
    expect(visibleOnChannel("1.2.0", "beta")).toBe(true);
    expect(() => channelOf("1.2.0-rc.1")).toThrow();
  });
});

describe("placeholders", () => {
  it("resolves the closed list and refuses anything else", () => {
    expect(renderString("https://$HOSTNAME/x", values)).toBe("https://crm.example.com/x");
    expect(renderString("$D1_ID(ros)", values)).toBe("D1_ID:crm");
    expect(renderString("$WORKER_NAME(ros-runner)", values)).toBe("x-ros-runner");
    expect(() => renderString("$PUBLIC_BASE_URL", values)).toThrow(/unknown placeholder/);
  });

  it("drops secret bindings without a value so the stored secret is kept", () => {
    const out = renderBindings(
      [
        { type: "secret_text", name: "KNOWN", text: "$SECRET(KNOWN)" },
        { type: "secret_text", name: "OTHER", text: "$SECRET(OTHER)" },
      ],
      values,
    );
    expect(out).toEqual([{ type: "secret_text", name: "KNOWN", text: "s3cret" }]);
  });

  it("flags a manifest with resolved values", async () => {
    const { manifest } = await buildFixtureRelease({ version: "1.0.0" });
    expect(() => assertUnresolved(manifest)).not.toThrow();
    const bad = structuredClone(manifest);
    (bad.workers[0]?.bindings[0] as Record<string, unknown>).database_id =
      "0123456789abcdef0123456789abcdef";
    expect(() => assertUnresolved(bad)).toThrow(/database_id is not a placeholder/);
  });
});

describe("archive", () => {
  it("is deterministic and round-trips", async () => {
    const entries = [
      { path: "b.txt", bytes: new TextEncoder().encode("bee") },
      { path: "a/x.bin", bytes: new Uint8Array(700).fill(7) },
    ];
    const one = await gzip(writeTar(entries));
    const two = await gzip(writeTar([...entries].reverse()));
    expect(await sha256Hex(one)).toBe(await sha256Hex(two));
    const files = readTar(await gunzip(one));
    expect([...files.keys()]).toEqual(["a/x.bin", "b.txt"]);
    expect(new TextDecoder().decode(files.get("b.txt"))).toBe("bee");
  });

  it("refuses unsafe paths", () => {
    expect(() => readTar(writeTar([{ path: "../evil", bytes: new Uint8Array(1) }]))).toThrow(
      /unsafe path/,
    );
  });

  it("decodes snappy (literals and copies)", () => {
    // "abcabcabc": length 9, literal "abc", copy offset 3 length 6.
    const data = new Uint8Array([9, (3 - 1) << 2, 97, 98, 99, ((6 - 1) << 2) | 2, 3, 0]);
    expect(new TextDecoder().decode(snappyDecompress(data))).toBe("abcabcabc");
  });
});

describe("bundles", () => {
  it("two builds of the same inputs hash identically", async () => {
    const a = await buildFixtureRelease({ version: "1.0.0" });
    const b = await buildFixtureRelease({ version: "1.0.0" });
    expect(a.digest).toBe(b.digest);
  });

  it("opens and checks every file against the manifest", async () => {
    const release = await buildFixtureRelease({ version: "1.0.0" });
    const bundle = await openBundle(release.bundle);
    expect(bundle.manifest.version).toBe("1.0.0");
    expect(bundle.migration("0001_meta.sql")).toContain("core_meta");
  });

  it("refuses a bundle whose module was swapped", async () => {
    const release = await buildFixtureRelease({ version: "1.0.0" });
    const files = readTar(await gunzip(release.bundle));
    const sha = release.manifest.workers[0]?.modules[0]?.sha256 as string;
    files.set(`modules/${sha}`, new TextEncoder().encode("evil()"));
    const tampered = await gzip(writeTar([...files].map(([path, bytes]) => ({ path, bytes }))));
    await expect(openBundle(tampered)).rejects.toThrow(BundleError);
  });
});

describe("deploy helpers", () => {
  it("orders dependencies first", async () => {
    const { manifest } = await buildFixtureRelease({ version: "1.0.0" });
    expect(deployOrder(manifest.workers).map((w) => w.name)).toEqual([
      "ros-runner",
      "ros-app",
      "ros-gatekeeper-test",
    ]);
  });

  it("sends only the Durable Object migration steps after the deployed tag", () => {
    const history = [
      { tag: "v1", new_sqlite_classes: ["A"] },
      { tag: "v2", new_sqlite_classes: ["B"] },
    ];
    expect(durableObjectMigration(history, undefined)).toEqual({
      new_tag: "v2",
      steps: [{ new_sqlite_classes: ["A"] }, { new_sqlite_classes: ["B"] }],
    });
    expect(durableObjectMigration(history, "v1")).toEqual({
      old_tag: "v1",
      new_tag: "v2",
      steps: [{ new_sqlite_classes: ["B"] }],
    });
    expect(durableObjectMigration(history, "v2")).toBeUndefined();
    expect(() => durableObjectMigration(history, "v9")).toThrow();
  });
});
