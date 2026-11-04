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

/** An extension's working copy in the workspace (stage 3b, ADR 0041): edited, not committed. */
export interface WorkingCopy {
  id: string;
  /** False when the workspace has no directory for this extension. */
  exists: boolean;
  /** The latest commit, or null before the first one. */
  head: string | null;
  files: Record<string, string>;
  /** Paths that differ from `head` (added, modified or deleted). */
  changed: string[];
  /** A shipped extension copied into the workspace with extension.eject. */
  ejected: boolean;
}

export interface WorkspaceEntry {
  id: string;
  head: string | null;
  files: string[];
  changed: boolean;
  ejected: boolean;
}

/** Who a Code Mode script acts as (ADR 0042): the connected user's MCP (or assistant) actor. */
export interface CodeCaller {
  actor: "mcp" | "assistant";
  user: { id: string; email: string; name: string; role: "admin" | "member" | "viewer" };
  origin: {
    surface: "mcp" | "ui";
    clientId?: string;
    clientName?: string;
    sessionId?: string;
  };
  grantedPermissions?: string[];
  /** Stored on anything the script's calls queue for approval. */
  reason?: string;
  approvalExpiryDays?: number;
}

export interface CodeLog {
  level: "log" | "info" | "warn" | "error";
  message: string;
}

export interface CodeOperationCall {
  operation: string;
  ok: boolean;
  /** Error code when it failed. */
  code?: string;
  /** Queued for approval (pending action id) instead of applied. */
  pendingActionId?: string;
  ms: number;
}

export interface CodeResult {
  ok: boolean;
  /** The script's default export (awaited, called when a function), as JSON. */
  value?: unknown;
  error?: { code: string; message: string };
  logs: CodeLog[];
  operations: CodeOperationCall[];
  /** The pending_approval results of calls the gate queued. */
  pending: unknown[];
  durationMs: number;
  /** Set when logs, operations or the value were cut to the runtime limits. */
  truncated?: boolean;
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

  // --- Stage 3b: authoring (ADR 0041) and Code Mode (ADR 0042) ------------------------------

  /** Every extension directory in the workspace, with its working-copy state. */
  listWorkspace(): Promise<WorkspaceEntry[]>;
  /** The working copy of `/extensions/<id>/` (uncommitted edits included). */
  workingCopy(id: string): Promise<WorkingCopy>;
  /**
   * Writes files into the working copy without committing. `null` deletes a file; `replace`
   * deletes every file not in `files`. Creates the directory (and its repository) if new.
   */
  writeFiles(input: {
    id: string;
    files: Record<string, string | null>;
    replace: boolean;
  }): Promise<WorkingCopy>;
  /** Commits the working copy as it is. `changed` is false when it equals the last commit. */
  commitWorkingCopy(input: {
    id: string;
    message: string;
    author: { name: string; email: string };
  }): Promise<{ commit: string; changed: boolean }>;
  /** Copies a shipped extension's bundled source into its working copy and marks it ejected. */
  eject(id: string): Promise<WorkingCopy>;
  /** Runs a Code Mode script as `caller`, through the gate. */
  runCode(input: { code: string; caller: CodeCaller }): Promise<CodeResult>;
  /**
   * Runs model role `build` on `prompt` (the AI-written summary of an extension change).
   * Null when the deployment has no AI configured or the call fails.
   */
  describeChange(prompt: string): Promise<{ text: string; model: string } | null>;
}
