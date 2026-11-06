// The extension workspace (ADR 0006, ADR 0025, ADR 0043): one Durable Object holding an
// @cloudflare/computer Workspace. Each extension's source lives in its own git repository at
// /extensions/<id>/; a commit is a version and rollback reinstalls an earlier commit.
//
// Since ADR 0043 the workspace runs no code. It keeps git, the working copies, and two caches the
// stateless executor (src/executor/) reads and fills: builds by content hash, and AI summaries of
// proposals by (commit, base). Tool runs, manifest evaluation, type checks and Code Mode run
// outside it, so they never queue behind each other here. Only git mutations are serialised.

import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import type {
  ExtensionVersion,
  ShippedExtension,
  WorkingCopy,
  WorkingCopyOptions,
  WorkspaceEntry,
  WorkspaceWrite,
} from "@relationship-os/core";
import type { BuildRecord } from "../executor/build-cache.ts";
import { buildKey, contentHash } from "../executor/worker-code.ts";
import { SHIPPED_EXTENSIONS } from "../generated/shipped.ts";

const IDENTITY = { name: "CRM extension workspace", email: "workspace@crm.invalid" };
/** Builds above this size (JSON) are not cached: a DO storage value is at most 2 MB. */
const MAX_CACHED_BUILD = 1_800_000;
/** Builds kept in the cache; the oldest are dropped beyond this. */
const MAX_CACHED_BUILDS = 200;

const extensionDir = (id: string) => `/extensions/${id}`;
const ejectedKey = (id: string) => `ejected:${id}`;
const dirtyKey = (id: string) => `dirty:${id}`;
const sourceKey = (id: string, commit: string) => `source:${id}:${commit}`;
const buildCacheKey = (key: string) => `build:${key}`;
const summaryKey = (id: string, commit: string, base: string | null) =>
  `summary:${id}:${commit}:${base ?? "-"}`;
const EXTENSION_ID = /^[a-z][a-z0-9]{1,29}$/;

function assertPath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === ".." || part === "." || part === "" || part === ".git")
  ) {
    throw new Error(`Invalid file path ${path}`);
  }
}

/** A content hash of a shipped extension's files (path order independent). */
export const shippedHash = contentHash;

/** What `sourceOf` returns: the source hash of a commit, and its build or its files. */
export type CommitSource =
  | { sourceHash: string; build: BuildRecord; files: null }
  | { sourceHash: string; build: null; files: Record<string, string> };

export class ExtensionWorkspace extends DurableObject<Env> {
  readonly workspace: Workspace;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // No execution backend: code runs in the stateless executor (ADR 0043).
    this.workspace = new Workspace({
      storage: ctx.storage,
      git: createGitClient(),
      defaultGitIdentity: IDENTITY,
    });
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await this.workspace.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Runs `task` after every earlier git mutation has finished. */
  #serialise<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #filesAt(id: string, commit: string): Promise<Record<string, string>> {
    const dir = extensionDir(id);
    const files: Record<string, string> = {};
    const walk = async (path: string) => {
      const entries = await this.workspace.git.lsTree({
        dir,
        ref: commit,
        ...(path ? { path } : {}),
      });
      for (const entry of entries) {
        const full = path ? `${path}/${entry.path}` : entry.path;
        if (entry.type === "tree") await walk(full);
        else if (entry.type === "blob") {
          const blob = await this.workspace.git.catFile({ dir, oid: entry.oid });
          files[full] = new TextDecoder().decode(blob.bytes);
        }
      }
    };
    await walk("");
    return files;
  }

  // -------------------------------------------------------------------------------------------
  // Caches for the executor (ADR 0043)

  /**
   * The source hash of `commit` and its cached build, or its files when it has not been built
   * with this runtime yet. Reads git only the first time a commit is seen.
   */
  async sourceOf(id: string, commit: string): Promise<CommitSource> {
    const known = await this.ctx.storage.get<string>(sourceKey(id, commit));
    if (known) {
      const build = await this.cachedBuild(known);
      if (build) return { sourceHash: known, build, files: null };
    }
    const files = await this.#filesAt(id, commit);
    const sourceHash = await contentHash(files);
    if (!known) await this.ctx.storage.put(sourceKey(id, commit), sourceHash);
    const build = await this.cachedBuild(sourceHash);
    return build ? { sourceHash, build, files: null } : { sourceHash, build: null, files };
  }

  /** The cached build of source `sourceHash` with this runtime and checker, if any. */
  async cachedBuild(sourceHash: string): Promise<BuildRecord | null> {
    const key = await buildKey(sourceHash);
    return (await this.ctx.storage.get<BuildRecord>(buildCacheKey(key))) ?? null;
  }

  async storeBuild(sourceHash: string, build: BuildRecord): Promise<void> {
    if (JSON.stringify(build).length > MAX_CACHED_BUILD) return;
    const key = await buildKey(sourceHash);
    const index = (await this.ctx.storage.get<string[]>("build-index")) ?? [];
    const next = [...index.filter((k) => k !== key), key];
    const dropped = next.splice(0, Math.max(0, next.length - MAX_CACHED_BUILDS));
    await this.ctx.storage.put({ [buildCacheKey(key)]: build, "build-index": next });
    if (dropped.length) await this.ctx.storage.delete(dropped.map(buildCacheKey));
    // Stage 3's executor kept builds as files under /build; drop them once (audit F18).
    if (!(await this.ctx.storage.get("legacy-build-dirs-removed"))) {
      await this.workspace.fs.rm("/build", { recursive: true, force: true }).catch(() => {});
      await this.ctx.storage.put("legacy-build-dirs-removed", true);
    }
  }

  /** A cached AI summary of a proposal of `commit` against `base`; undefined when not cached. */
  async cachedSummary(
    id: string,
    commit: string,
    base: string | null,
  ): Promise<{ text: string; model: string } | undefined> {
    return this.ctx.storage.get(summaryKey(id, commit, base));
  }

  async storeSummary(
    id: string,
    commit: string,
    base: string | null,
    summary: { text: string; model: string },
  ): Promise<void> {
    await this.ctx.storage.put(summaryKey(id, commit, base), summary);
  }

  // -------------------------------------------------------------------------------------------
  // Git

  async commit(input: {
    id: string;
    files: Record<string, string>;
    message: string;
    author: { name: string; email: string };
  }): Promise<{ commit: string; changed: boolean }> {
    return this.#serialise(() => this.#commit(input.id, input.files, input.message, input.author));
  }

  async #commit(
    id: string,
    files: Record<string, string>,
    message: string,
    author: { name: string; email: string },
  ): Promise<{ commit: string; changed: boolean }> {
    if (!EXTENSION_ID.test(id)) throw new Error(`Invalid extension id ${id}`);
    const dir = extensionDir(id);
    const fs = this.workspace.fs;
    const git = this.workspace.git;
    if (!(await this.#exists(`${dir}/.git`))) {
      await fs.mkdir(dir, { recursive: true });
      await git.init({ dir });
    }
    const existing = (await git.lsFiles({ dir })).filter((p) => !Object.hasOwn(files, p));
    for (const path of existing) {
      await fs.rm(`${dir}/${path}`, { force: true });
    }
    if (existing.length) await git.rm({ dir, paths: existing });
    for (const [path, text] of Object.entries(files)) {
      if (path.split("/").some((part) => part === ".." || part === "" || part === ".git")) {
        throw new Error(`Invalid file path ${path}`);
      }
      const target = `${dir}/${path}`;
      await fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await fs.writeFile(target, text);
    }
    await git.add({ dir, paths: Object.keys(files) });
    const status = await git.status({ dir });
    const head = await git.log({ dir, depth: 1 }).catch(() => []);
    let result: { commit: string; changed: boolean };
    if (!status.length && head[0]) result = { commit: head[0].oid, changed: false };
    else {
      const { oid } = await git.commit({ dir, message, author });
      result = { commit: oid, changed: true };
    }
    // The working copy now equals the commit.
    await this.ctx.storage.put(dirtyKey(id), false);
    return result;
  }

  async shipped(): Promise<ShippedExtension[]> {
    return SHIPPED_EXTENSIONS.map(({ files: _files, ...meta }) => meta);
  }

  /**
   * Every new ros-app isolate calls this (through installShipped) on its first request. When the
   * bundled source is the one already committed and the repository's HEAD is still that commit,
   * it returns at once.
   */
  async commitShipped(id: string): Promise<{ commit: string; changed: boolean }> {
    const shipped = SHIPPED_EXTENSIONS.find((s) => s.id === id);
    if (!shipped) throw new Error(`No shipped extension ${id}`);
    if (await this.ctx.storage.get(ejectedKey(id))) {
      throw new Error(`${id} was ejected; releases no longer update it`);
    }
    return this.#serialise(async () => {
      const hash = await shippedHash(shipped.files);
      const key = `shipped:${id}`;
      const known = await this.ctx.storage.get<{ hash: string; commit: string }>(key);
      if (known?.hash === hash && (await this.#head(id)) === known.commit) {
        return { commit: known.commit, changed: false };
      }
      const result = await this.#commit(
        id,
        shipped.files,
        `Shipped ${id} ${shipped.version}`,
        IDENTITY,
      );
      await this.ctx.storage.put(key, { hash, commit: result.commit });
      return result;
    });
  }

  async #head(id: string): Promise<string | null> {
    const dir = extensionDir(id);
    if (!(await this.#exists(`${dir}/.git`))) return null;
    const log = await this.workspace.git.log({ dir, depth: 1 }).catch(() => []);
    return log[0]?.oid ?? null;
  }

  async versions(id: string): Promise<ExtensionVersion[]> {
    const dir = extensionDir(id);
    if (!(await this.#exists(`${dir}/.git`))) return [];
    const log = await this.workspace.git.log({ dir }).catch(() => []);
    return log.map((c) => ({
      commit: c.oid,
      message: c.message.trim(),
      at: new Date(c.committer.timestamp * 1000).toISOString(),
    }));
  }

  async files(id: string, commit: string): Promise<Record<string, string>> {
    return this.#filesAt(id, commit);
  }

  // -------------------------------------------------------------------------------------------
  // Authoring (ADR 0041): the working copy

  /** Paths under `/extensions/<id>/` now (uncommitted edits included), without reading them. */
  async #workingPaths(id: string): Promise<string[]> {
    const dir = extensionDir(id);
    const paths: string[] = [];
    const walk = async (rel: string) => {
      const entries = await this.workspace.fs.readdir(rel ? `${dir}/${rel}` : dir);
      for (const entry of entries) {
        if (!rel && entry.name === ".git") continue;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory) await walk(path);
        else if (entry.isFile) paths.push(path);
      }
    };
    if (await this.#exists(dir)) await walk("");
    return paths.sort();
  }

  async #read(id: string, paths: readonly string[]): Promise<Record<string, string>> {
    const dir = extensionDir(id);
    const files: Record<string, string> = {};
    for (const path of paths) {
      try {
        files[path] = await this.workspace.fs.readFile(`${dir}/${path}`, "utf8");
      } catch {
        // Not in the working copy.
      }
    }
    return files;
  }

  /** Paths that differ from HEAD (git status; reads every file). */
  async #changed(id: string): Promise<string[]> {
    const status = await this.workspace.git.status({ dir: extensionDir(id) });
    return status
      .filter((s) => s.index !== " " || s.worktree !== " ")
      .map((s) => s.path)
      .sort();
  }

  /** Whether the working copy was edited since its last commit (a stored flag). */
  async #dirty(id: string): Promise<boolean> {
    const flag = await this.ctx.storage.get<boolean>(dirtyKey(id));
    if (flag !== undefined) return flag;
    // Working copies from before the flag existed: work it out once.
    const dirty = (await this.#changed(id)).length > 0;
    await this.ctx.storage.put(dirtyKey(id), dirty);
    return dirty;
  }

  async #workingCopy(id: string, options: WorkingCopyOptions = {}): Promise<WorkingCopy> {
    if (!EXTENSION_ID.test(id)) throw new Error(`Invalid extension id ${id}`);
    const dir = extensionDir(id);
    const ejected = Boolean(await this.ctx.storage.get(ejectedKey(id)));
    if (!(await this.#exists(`${dir}/.git`))) {
      return { id, exists: false, head: null, files: {}, changed: [], ejected };
    }
    const paths = options.paths ?? (await this.#workingPaths(id));
    const files = paths.length ? await this.#read(id, paths) : {};
    const head = await this.#head(id);
    const changed = options.status === false ? [] : await this.#changed(id);
    return { id, exists: true, head, files, changed, ejected };
  }

  /**
   * The working copy. By default every file and its git status; `paths` reads only those files
   * (none for `[]`) and `status: false` skips git status (which reads every file).
   */
  async workingCopy(id: string, options?: WorkingCopyOptions): Promise<WorkingCopy> {
    return this.#serialise(() => this.#workingCopy(id, options));
  }

  /** Directory names with a dirty flag: no file reads and no git status (audit, ADR 0043). */
  async listWorkspace(): Promise<WorkspaceEntry[]> {
    if (!(await this.#exists("/extensions"))) return [];
    const ejected = await this.ctx.storage.list({ prefix: "ejected:" });
    const out: WorkspaceEntry[] = [];
    for (const entry of await this.workspace.fs.readdir("/extensions")) {
      if (!entry.isDirectory || !EXTENSION_ID.test(entry.name)) continue;
      out.push({
        id: entry.name,
        changed: await this.#dirty(entry.name),
        ejected: ejected.has(ejectedKey(entry.name)),
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async #writeFiles(
    id: string,
    files: Record<string, string | null>,
    replace: boolean,
  ): Promise<WorkspaceWrite> {
    if (!EXTENSION_ID.test(id)) throw new Error(`Invalid extension id ${id}`);
    const dir = extensionDir(id);
    const fs = this.workspace.fs;
    if (!(await this.#exists(`${dir}/.git`))) {
      await fs.mkdir(dir, { recursive: true });
      await this.workspace.git.init({ dir });
    }
    for (const path of Object.keys(files)) assertPath(path);
    if (replace) {
      for (const path of await this.#workingPaths(id)) {
        if (!Object.hasOwn(files, path)) await fs.rm(`${dir}/${path}`, { force: true });
      }
    }
    for (const [path, text] of Object.entries(files)) {
      const target = `${dir}/${path}`;
      if (text === null) {
        await fs.rm(target, { force: true });
        continue;
      }
      await fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await fs.writeFile(target, text);
    }
    await this.ctx.storage.put(dirtyKey(id), true);
    return {
      id,
      head: await this.#head(id),
      paths: await this.#workingPaths(id),
      changed: true,
      ejected: Boolean(await this.ctx.storage.get(ejectedKey(id))),
    };
  }

  async writeFiles(input: {
    id: string;
    files: Record<string, string | null>;
    replace: boolean;
  }): Promise<WorkspaceWrite> {
    return this.#serialise(() => this.#writeFiles(input.id, input.files, input.replace));
  }

  async commitWorkingCopy(input: {
    id: string;
    message: string;
    author: { name: string; email: string };
  }): Promise<{ commit: string; changed: boolean }> {
    return this.#serialise(async () => {
      const files = await this.#read(input.id, await this.#workingPaths(input.id));
      if (!Object.keys(files).length) throw new Error(`${input.id} has no files to commit`);
      return this.#commit(input.id, files, input.message, input.author);
    });
  }

  async eject(id: string): Promise<WorkspaceWrite> {
    const shipped = SHIPPED_EXTENSIONS.find((s) => s.id === id);
    if (!shipped) throw new Error(`No shipped extension ${id}`);
    return this.#serialise(async () => {
      await this.ctx.storage.put(ejectedKey(id), new Date().toISOString());
      return this.#writeFiles(id, shipped.files, true);
    });
  }
}
