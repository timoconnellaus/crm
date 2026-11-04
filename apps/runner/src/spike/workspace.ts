// Stage 0 spike (ADR 0006): a Durable Object holding an @cloudflare/computer Workspace whose code
// runs in Worker Loader Dynamic Workers with no network, plus a fake `codemode:crm` host module.
// Findings: docs/spikes/0001-dynamic-runtime.md. Served only behind the dev-only /dev/spike route.
import { DurableObject } from "cloudflare:workers";
import { Workspace, type WorkspaceRuntimeValue } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";

const PEOPLE: Record<string, { id: string; name: string; email: string }> = {
  p1: { id: "p1", name: "Ada Lovelace", email: "ada@example.com" },
  p2: { id: "p2", name: "Grace Hopper", email: "grace@example.com" },
};

export interface SpikeExecResult {
  status: string;
  exitCode: number;
  /** The module's return value, JSON-encoded (keeps the RPC return type non-recursive). */
  valueJson: string;
  stdout: string;
  stderr: string;
  /** Wall-clock ms from `runtime.exec()` to the settled result, measured in the DO. */
  ms: number;
}

export class SpikeWorkspace extends DurableObject<Env> {
  readonly workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workspace = new Workspace({
      storage: ctx.storage,
      git: createGitClient(),
      defaultGitIdentity: { name: "CRM spike", email: "spike@crm.invalid" },
      backends: [
        new WorkerJavaScriptBackend({
          loader: env.LOADER,
          root: "/workspace",
          globalOutbound: null,
          defaultTimeoutMs: 30_000,
          maxTimeoutMs: 180_000,
          modules: {
            "codemode:crm": {
              getPerson: ([id]) => PEOPLE[String(id)] ?? null,
            },
            "codemode:git": createGitModule(),
          },
        }),
      ],
    });
  }

  async exec(
    source: string,
    options: { input?: WorkspaceRuntimeValue; timeoutMs?: number } = {},
  ): Promise<SpikeExecResult> {
    const started = performance.now();
    const handle = await this.workspace.runtime.exec(source, {
      backend: "worker-javascript",
      encoding: "utf8",
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const result = await handle.result();
    const ms = performance.now() - started;
    return {
      status: result.status,
      exitCode: result.exitCode,
      valueJson: JSON.stringify(result.value ?? null),
      stdout: result.stdout,
      stderr: result.stderr,
      ms,
    } satisfies SpikeExecResult;
  }

  /** Reads back the last commit's diff through the host's typed git client. */
  async lastCommitDiff(dir: string) {
    const started = performance.now();
    const log = await this.workspace.git.log({ dir, depth: 2 });
    const head = log[0];
    const parent = log[1];
    const diff =
      head && parent ? await this.workspace.git.diff({ dir, ref: parent.oid, to: head.oid }) : "";
    const summary =
      head && parent
        ? await this.workspace.git.diffSummary({ dir, ref: parent.oid, to: head.oid })
        : [];
    return {
      commits: log.map((c) => ({ oid: c.oid, message: c.message })),
      diff,
      summary,
      ms: performance.now() - started,
    };
  }
}
