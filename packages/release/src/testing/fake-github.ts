// A fake GitHub (Releases and the attestations API) for tests. `publish` adds a release with its
// assets and, unless told otherwise, a build-provenance attestation for the bundle's digest made
// by the release workflow at the release's tag, shaped like actions/attest-build-provenance's.

import { RELEASE_WORKFLOW_PATH, SLSA_PROVENANCE_V1 } from "../attestation.ts";
import { releaseAssetNames } from "../bundle.ts";
import { sha256Hex, toBase64 } from "../hash.ts";
import type { FixtureRelease } from "./fixture-release.ts";

export interface PublishOptions {
  /** Add an attestation (default true). */
  attest?: boolean;
  /** Override the attested workflow (e.g. a fork, or another workflow). */
  workflow?: { repository?: string; path?: string; ref?: string };
  /** Replace the bundle bytes after publishing (a tampered asset) and optionally fix SHA256SUMS. */
  tamper?: { bytes: Uint8Array; rewriteSums?: boolean };
  draft?: boolean;
  notes?: string;
}

interface Stored {
  tag: string;
  prerelease: boolean;
  draft: boolean;
  notes: string;
  assets: Map<string, Uint8Array>;
  publishedAt: string;
}

export class FakeGitHub {
  readonly base: string;
  readonly api: string;
  readonly releases: Stored[] = [];
  readonly attestations = new Map<string, { _bundle: unknown; [key: string]: unknown }[]>();
  requests = 0;

  readonly repository: string;
  /** `origin` serves both the API and downloads (for a fake served over HTTP). */
  constructor(repository = "timoconnellaus/crm", origin?: string) {
    this.repository = repository;
    this.base = origin ?? "https://github.test";
    this.api = origin ?? "https://api.github.test";
  }

  async publish(release: FixtureRelease, options: PublishOptions = {}) {
    const names = releaseAssetNames(release.version);
    let bundle = release.bundle;
    let sums = release.sums;
    if (options.tamper) {
      bundle = options.tamper.bytes;
      if (options.tamper.rewriteSums) {
        sums = `${await sha256Hex(bundle)}  ${names.bundle}\n`;
      }
    }
    const assets = new Map<string, Uint8Array>([
      [names.bundle, bundle],
      [names.manifest, new TextEncoder().encode(release.manifestText)],
      [names.sums, new TextEncoder().encode(sums)],
    ]);
    this.releases.push({
      tag: `v${release.version}`,
      prerelease: release.version.includes("-"),
      draft: options.draft ?? false,
      notes: options.notes ?? `## What's changed\n\n- Release ${release.version}`,
      assets,
      publishedAt: new Date(Date.UTC(2026, 10, this.releases.length + 1)).toISOString(),
    });
    if (options.attest !== false) {
      this.attest(release.digest, `v${release.version}`, options.workflow);
    }
  }

  attest(digest: string, tag: string, workflow: PublishOptions["workflow"] = {}) {
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "bundle", digest: { sha256: digest } }],
      predicateType: SLSA_PROVENANCE_V1,
      predicate: {
        buildDefinition: {
          buildType: "https://actions.github.io/buildtypes/workflow/v1",
          externalParameters: {
            workflow: {
              ref: workflow.ref ?? `refs/tags/${tag}`,
              repository: workflow.repository ?? `https://github.com/${this.repository}`,
              path: workflow.path ?? RELEASE_WORKFLOW_PATH,
            },
          },
        },
      },
    };
    const bundle = {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      dsseEnvelope: {
        payload: toBase64(new TextEncoder().encode(JSON.stringify(statement))),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ sig: "ZmFrZQ==" }],
      },
    };
    const list = this.attestations.get(digest) ?? [];
    // Like GitHub today: no inline bundle, a URL to fetch it from.
    list.push({
      repository_id: 1,
      bundle: null,
      bundle_url: `${this.base}/bundles/${digest}/${list.length}`,
      _bundle: bundle,
    });
    this.attestations.set(digest, list);
  }

  private view(release: Stored) {
    return {
      tag_name: release.tag,
      name: release.tag,
      body: release.notes,
      draft: release.draft,
      prerelease: release.prerelease,
      published_at: release.publishedAt,
      html_url: `${this.base}/${this.repository}/releases/tag/${release.tag}`,
      assets: [...release.assets.keys()].map((name) => ({
        name,
        url: `${this.api}/assets/${name}`,
        browser_download_url: `${this.base}/${this.repository}/releases/download/${release.tag}/${name}`,
      })),
    };
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    this.requests += 1;
    const url = new URL(new Request(input, init).url);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const repoPath = `/repos/${this.repository}`;
    if (url.origin === this.api) {
      if (url.pathname === `${repoPath}/releases`) {
        return json(
          200,
          [...this.releases].reverse().map((r) => this.view(r)),
        );
      }
      const tag = new RegExp(`^${repoPath}/releases/tags/(.+)$`).exec(url.pathname);
      if (tag) {
        const release = this.releases.find((r) => r.tag === tag[1] && !r.draft);
        return release ? json(200, this.view(release)) : json(404, { message: "Not Found" });
      }
      const att = /^\/repos\/([^/]+\/[^/]+)\/attestations\/sha256:([0-9a-f]+)$/.exec(url.pathname);
      if (att) {
        if (att[1] !== this.repository) return json(404, { message: "Not Found" });
        const list = this.attestations.get(att[2] as string);
        if (!list?.length) return json(404, { message: "Not Found" });
        return json(200, { attestations: list.map(({ _bundle, ...rest }) => rest) });
      }
      if (url.pathname.startsWith("/repos/")) return json(404, { message: "Not Found" });
    }
    if (url.origin === this.base) {
      const bundle = /^\/bundles\/([0-9a-f]+)\/(\d+)$/.exec(url.pathname);
      if (bundle) {
        const entry = this.attestations.get(bundle[1] as string)?.[Number(bundle[2])];
        return entry ? json(200, entry._bundle) : new Response("gone", { status: 404 });
      }
      const download = new RegExp(`^/${this.repository}/releases/download/([^/]+)/(.+)$`).exec(
        url.pathname,
      );
      if (download) {
        const release = this.releases.find((r) => r.tag === download[1]);
        const bytes = release?.assets.get(download[2] as string);
        return bytes
          ? new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200 })
          : new Response("Not Found", { status: 404 });
      }
    }
    return json(404, { message: `fake GitHub has no ${url.href}` });
  };
}
