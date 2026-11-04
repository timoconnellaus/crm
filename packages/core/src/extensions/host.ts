// The port between the operations registry and the extension runtime (ADR 0025). crm-runner
// implements it (the extension workspace Durable Object: files, git, the sandbox); crm-app
// reaches the same implementation over the RUNNER service binding. Extension operations receive
// it through the invocation context, so packages/core never imports the runtime.

/** A problem found evaluating extension source (before the manifest exists). */
export interface SourceIssue {
  code: "syntax" | "import" | "entry" | "evaluate" | "too_large" | "type";
  path: string;
  message: string;
}

export type EvaluateResult =
  | { ok: true; manifest: unknown; commit: string | null }
  | { ok: false; issues: SourceIssue[]; commit: string | null };

export interface ToolCaller {
  actor: string;
  userId: string;
}

export interface RunToolInput {
  id: string;
  commit: string;
  tool: string;
  input: unknown;
  caller: ToolCaller;
}

export type RunToolResult =
  | { ok: true; value: unknown; runId: string }
  | {
      ok: false;
      error: { code: string; message: string; details?: unknown };
      runId: string;
      /** True when this failure quarantined the extension. */
      quarantined: boolean;
    };

export interface ExtensionVersion {
  commit: string;
  message: string;
  at: string;
}

export interface ShippedExtension {
  id: string;
  version: string;
}

export interface ExtensionHost {
  /**
   * Writes `files` as `/extensions/<id>/` in the workspace (replacing what was there) and
   * commits. Returns the commit; `changed` is false when the files were already committed.
   */
  commit(input: {
    id: string;
    files: Record<string, string>;
    message: string;
    author: { name: string; email: string };
  }): Promise<{ commit: string; changed: boolean }>;
  /** Shipped extensions bundled with this release. */
  shipped(): Promise<ShippedExtension[]>;
  /** Commits a shipped extension's bundled source (a no-op when unchanged). */
  commitShipped(id: string): Promise<{ commit: string; changed: boolean }>;
  /**
   * Evaluates source in the sandbox: transpile (syntax), check imports, run the entry with no
   * host modules and return its manifest. Pass `commit` for committed source or `files` for a
   * dry run that is not committed.
   */
  evaluate(
    input: { id: string; commit: string } | { id: string; files: Record<string, string> },
  ): Promise<EvaluateResult>;
  /** Runs a tool of the installed version in the sandbox, recording a run. */
  runTool(input: RunToolInput): Promise<RunToolResult>;
  /** Commits of `/extensions/<id>/`, newest first. */
  versions(id: string): Promise<ExtensionVersion[]>;
  /** The files of an extension at a commit. */
  files(id: string, commit: string): Promise<Record<string, string>>;
}
