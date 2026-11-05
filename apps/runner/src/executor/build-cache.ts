// Building extension source once (ADR 0043): transpile and import-check (build.ts), then the
// TypeScript check in its own Dynamic Worker. The result is cached in the workspace DO by a content
// hash of the files (plus the runtime and checker hashes), so `extension.check` on a working copy,
// `extension.propose` of the same files, approval and every cold tool worker share one build and
// one type check. The work happens here, in the stateless caller, never inside the DO.
import type { SourceIssue } from "@relationship-os/core";
import { buildExtension } from "../extensions/build.ts";
import type { ExtensionWorkspace } from "../extensions/workspace.ts";
import CHECKER from "../generated/checker.txt";
import { checkerWorkerId, contentHash } from "./worker-code.ts";

export type BuildRecord =
  | { ok: true; modules: Record<string, string> }
  | { ok: false; issues: SourceIssue[] };

export type BuildSource =
  | { id: string; commit: string }
  | { id: string; files: Record<string, string> };

export interface BuildEnv {
  EXTENSION_WORKSPACE: DurableObjectNamespace<ExtensionWorkspace>;
}

export function workspaceStub(env: BuildEnv): DurableObjectStub<ExtensionWorkspace> {
  return env.EXTENSION_WORKSPACE.getByName("workspace");
}

/** The checker's Dynamic Worker: reused across checks, so it has a stable id. */
export function checkerWorker(loader: WorkerLoader): WorkerStub {
  return loader.get(checkerWorkerId(), () => ({
    compatibilityDate: "2026-10-01",
    // The compiler bundle was built for nodejs_compat (scripts/bundle.mjs sets process.browser).
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "checker.js",
    modules: { "checker.js": CHECKER },
    globalOutbound: null,
    env: {},
  }));
}

interface CheckerEntrypoint {
  check(files: Record<string, string>): Promise<SourceIssue[]>;
}

/** Type-checks extension source in the checker worker. */
export async function typecheck(
  loader: WorkerLoader,
  files: Record<string, string>,
): Promise<SourceIssue[]> {
  const checker = checkerWorker(loader).getEntrypoint() as unknown as CheckerEntrypoint;
  return checker.check(files);
}

/** Builds and checks `files` (no cache). */
export async function compile(
  loader: WorkerLoader,
  files: Record<string, string>,
): Promise<BuildRecord> {
  const built = buildExtension(files);
  if (!built.ok) return built;
  const issues = await typecheck(loader, files);
  return issues.length ? { ok: false, issues } : { ok: true, modules: built.modules };
}

/** The build of `source`, from the cache or built now (and cached). */
export async function prepare(
  env: BuildEnv,
  loader: WorkerLoader,
  source: BuildSource,
): Promise<{ sourceHash: string; build: BuildRecord; cached: boolean }> {
  const ws = workspaceStub(env);
  let files: Record<string, string>;
  let sourceHash: string;
  if ("files" in source) {
    files = source.files;
    sourceHash = await contentHash(files);
    const cached = await ws.cachedBuild(sourceHash);
    if (cached) return { sourceHash, build: cached as BuildRecord, cached: true };
  } else {
    const known = await ws.sourceOf(source.id, source.commit);
    if (known.build) {
      return { sourceHash: known.sourceHash, build: known.build as BuildRecord, cached: true };
    }
    files = known.files as Record<string, string>;
    sourceHash = known.sourceHash;
  }
  const build = await compile(loader, files);
  await ws.storeBuild(sourceHash, build);
  return { sourceHash, build, cached: false };
}
