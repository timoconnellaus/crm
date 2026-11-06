// What an agent may do (ADR 0344): its grant. Operations, a target set, count caps and an expiry,
// checked in code when it starts (never wider than its starter) and on every call it makes, in the
// pipeline, through a guard. The judge's `grant.leastPrivilege` is a second opinion about the
// brief; these rules hold with or without it.
//
// Every call an agent makes lands in one of three places:
//   auto     fill an empty field, or add a note or task, on an in-scope record, within the caps
//   stage    the job's change set: changing a value, anything else inside the grant, anything past
//            a cap or the expiry. Email and irreversible actions always come here at the least
//   outside  its own change set, so it comes back as its own card
// The grant only ever tightens: the gate's own decision still applies, and a call it would review
// or deny stays reviewed or denied (nothing here loosens policy).
import type { CoreDatabase } from "@relationship-os/db";
import { checkGrant } from "@relationship-os/sdk";
import type { Kysely } from "kysely";
import { z } from "zod";
import { diffRecords } from "../diff.ts";
import { ForbiddenError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { type Filter, filterSchema } from "../filter.ts";
import { evaluateGate, type GateFloor } from "../gate.ts";
import type { AnyOperation, ExtensionCaller, HandlerContext, RecordChange } from "../operation.ts";
import { type ActingUser, type Actor, roleHasPermission } from "../principals.ts";
import { loadApprovalPolicy } from "../settings.ts";
import { recordMatches } from "./memory.ts";

const operationName = z.string().min(3).max(120);

export const grantTargetSchema = z.union([
  z.object({
    ids: z.array(z.string().min(1).max(64)).max(1_000).describe("The records, by id"),
  }),
  z.object({
    object: z.string().min(1).max(64).describe("The kind of record"),
    filter: filterSchema.describe("Which of them, as a view filter"),
  }),
]);
export type GrantTarget = z.infer<typeof grantTargetSchema>;

export const grantCapsSchema = z.object({
  changes: z.number().int().min(0).max(5_000).describe("Fields filled, without review"),
  notes: z.number().int().min(0).max(5_000).default(0).describe("Notes added, without review"),
  tasks: z.number().int().min(0).max(5_000).default(0).describe("Tasks added, without review"),
});

export const grantSchema = z.object({
  operations: z.array(operationName).min(1).max(60),
  target: grantTargetSchema,
  caps: grantCapsSchema,
  expiresAt: z.iso.datetime(),
});
export type Grant = z.infer<typeof grantSchema>;

/** What a job has used of its grant. */
export interface GrantUsage {
  changes: number;
  notes: number;
  tasks: number;
}

export const EMPTY_GRANT_USAGE: GrantUsage = { changes: 0, notes: 0, tasks: 0 };

/** Who started a job. Its grant may not exceed what this may do. */
export type JobStarter =
  | { kind: "user"; id: string; actor: Actor }
  | { kind: "routine"; id: string; actor: Actor }
  | { kind: "plugin"; id: string; actor: Actor; extension: ExtensionCaller };

/** What every agent can do, whatever its grant: report progress and see its own pending changes. */
export const BASE_OPERATIONS: readonly string[] = ["agent.progress", "approval.status"];

/**
 * Operations no grant can hold. Agents do not start agents, write memory or decide approvals.
 * Anything that runs other operations (Code Mode, cards' buttons) would step outside the guard, and
 * settings, users and extensions are for people.
 */
const NEVER_GRANTED =
  /^(agent|agentProfile|memory|teamMemory|thread|assistant|approval|changeset|policy|code|a2ui|extension|automation|user|connectedApp|settings|setup|support|update|judge|ai|voice|adjudicator|retention|erasure|connection|integration)\./;

/**
 * The gatekeeper calls an agent may hold: reading a connection. A side effect one causes is gated
 * on its own as an outbound action, and an agent's always waits for the person.
 */
const GATEKEEPER_CALLS = new Set(["integration.call", "integration.types", "connection.list"]);

/** Why an operation cannot be granted to an agent, or null. */
export function ungrantable(name: string): string | null {
  if (GATEKEEPER_CALLS.has(name)) return null;
  return NEVER_GRANTED.test(name) ? `Agents cannot be granted ${name}` : null;
}

/** How a grant reads to the starter, the judge and the person. */
export function targetWords(target: GrantTarget): string {
  if ("ids" in target) {
    const n = target.ids.length;
    return `${n} record${n === 1 ? "" : "s"}`;
  }
  return `every ${target.object} matching a filter`;
}

export interface StarterCheck {
  db: Kysely<CoreDatabase>;
  user: ActingUser;
  starter: JobStarter;
  floor?: GateFloor | undefined;
  grantedPermissions?: readonly string[] | undefined;
  resolve: (name: string) => AnyOperation | undefined;
}

/**
 * A grant can never exceed what its starter may do (ADR 0344). Checked here, in code, for every
 * operation: it exists, an agent may hold it, the agent's actor may call it, and the starter's
 * role, credential, policy and (for a plugin) declared permissions allow it. The first problem
 * throws, naming the operation.
 */
export async function assertWithinStarter(grant: Grant, check: StarterCheck): Promise<void> {
  const policy = await loadApprovalPolicy(check.db);
  for (const name of grant.operations) {
    const reason = ungrantable(name);
    if (reason) throw new ForbiddenError(reason, { operation: name });
    const op = check.resolve(name);
    if (!op) throw new ValidationError(`No operation named "${name}"`, { operation: name });
    const beyond = (why: string) =>
      new ForbiddenError(`This agent cannot have ${name}: ${why}`, { operation: name });
    if (op.actors && !op.actors.includes("assistant")) throw beyond("it is for people only");
    if (!roleHasPermission(check.user.role, op.permission)) {
      throw beyond(`your role (${check.user.role}) cannot do it`);
    }
    if (check.grantedPermissions && !check.grantedPermissions.includes(op.permission)) {
      throw beyond("the credential that started it cannot do it");
    }
    for (const actor of new Set<Actor>([check.starter.actor, "assistant"])) {
      const gate = evaluateGate({ actor, risk: op.risk }, policy, check.floor);
      if (gate.decision === "deny") throw beyond("the approval policy does not allow it");
    }
    if (check.starter.kind === "plugin") {
      const allowed = checkGrant(check.starter.extension.id, check.starter.extension.permissions, {
        operation: name,
        risk: op.risk,
        object: name.split(".")[0] ?? null,
      });
      if (!allowed.ok) throw beyond(allowed.reason);
    }
  }
  if ("object" in grant.target && !getObject(grant.target.object)) {
    throw new ValidationError(`No object named "${grant.target.object}"`);
  }
}

// ---------------------------------------------------------------------------------------------
// The guard: every call an agent makes, in the pipeline

export type GrantRoute = "auto" | "stage" | "outside";

/** Set on an agent's invocations. Nothing else sets it, and a model never sees it. */
export interface GrantGuard {
  jobId: string;
  /** May this read run? Reads cannot wait for review, so one outside the grant is refused. */
  allowsRead(op: AnyOperation): boolean;
  /** Does a write need dry-running? Not one that goes to review whatever it would change. */
  needsChanges(op: AnyOperation): boolean;
  /** Where a write goes, from the changes it would make. */
  route(
    op: AnyOperation,
    changes: readonly RecordChange[],
    now: string,
    db: Kysely<CoreDatabase>,
  ): Promise<GrantRoute>;
  /** A call the guard let through was committed. */
  applied(changes: readonly RecordChange[]): void;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** The fields a change fills, or null when it changes a value that was there. */
function filledFields(change: RecordChange): number | null {
  const diff = change.diff ?? diffRecords(change.before, change.after);
  let filled = 0;
  for (const [field, { before }] of Object.entries(diff)) {
    if (field === "updatedBy") continue;
    if (!isEmpty(before)) return null;
    filled += 1;
  }
  return filled;
}

/** A note or a task's links: "person:per_…". */
function linksOf(change: RecordChange): { object: string; id: string }[] {
  const links = change.after?.links;
  if (!Array.isArray(links)) return [];
  return links.flatMap((link) => {
    if (typeof link !== "string" || !link.includes(":")) return [];
    const at = link.indexOf(":");
    return [{ object: link.slice(0, at), id: link.slice(at + 1) }];
  });
}

function kindOf(change: RecordChange): keyof GrantUsage | null {
  if (change.action === "create") {
    if (change.object === "task") return "tasks";
    if (change.object === "activity" && change.after?.type === "note") return "notes";
    return null;
  }
  return change.action === "update" ? "changes" : null;
}

/** Risk classes that always need the person, whatever the grant and the policy say. */
const PERSON_ONLY = new Set(["outbound", "destructive", "schema", "extension"]);

export interface GuardInput {
  jobId: string;
  grant: Grant;
  /** "Start, but ask me for every change". */
  reviewEverything: boolean;
  used: GrantUsage;
  /** Fields filled, for the card. */
  onApplied?: (usage: GrantUsage, filled: number) => void;
}

/** The guard for one job. `used` carries over from the job's earlier slices. */
export function grantGuard(input: GuardInput): GrantGuard {
  const { grant } = input;
  const allowed = new Set([...grant.operations, ...BASE_OPERATIONS]);
  const used = { ...input.used };

  async function inScope(
    db: Kysely<CoreDatabase>,
    record: { object: string; id: string },
  ): Promise<boolean> {
    const target = grant.target;
    if ("ids" in target) return target.ids.includes(record.id);
    if (target.object !== record.object) return false;
    const object = getObject(record.object);
    return object ? recordMatches(db, object, target.filter as Filter, record.id) : false;
  }

  return {
    jobId: input.jobId,
    allowsRead: (op) => allowed.has(op.name),
    needsChanges: (op) => allowed.has(op.name) && !PERSON_ONLY.has(op.risk),
    async route(op, changes, now, db) {
      if (!allowed.has(op.name)) return "outside";
      if (PERSON_ONLY.has(op.risk) || op.name.startsWith("x.") || !changes.length) return "stage";
      if (input.reviewEverything || now >= grant.expiresAt) return "stage";
      const planned = { ...used };
      for (const change of changes) {
        const kind = kindOf(change);
        if (!kind) return "stage";
        if (kind === "changes") {
          if (!(await inScope(db, change))) return "outside";
          const filled = filledFields(change);
          if (filled === null) return "stage";
          planned.changes += filled;
        } else {
          const links = linksOf(change);
          if (!links.length) return "stage";
          for (const link of links) if (!(await inScope(db, link))) return "outside";
          planned[kind] += 1;
        }
      }
      const within =
        planned.changes <= grant.caps.changes &&
        planned.notes <= grant.caps.notes &&
        planned.tasks <= grant.caps.tasks;
      return within ? "auto" : "stage";
    },
    applied(changes) {
      let filled = 0;
      for (const change of changes) {
        const kind = kindOf(change);
        if (kind === "changes") {
          const count = filledFields(change) ?? 0;
          used.changes += count;
          filled += count;
        } else if (kind) used[kind] += 1;
      }
      input.onApplied?.({ ...used }, filled);
    },
  };
}

/** The session a job's changes group under: its change set, and what only it sees simulated. */
export function jobSession(jobId: string): string {
  return `job:${jobId}`;
}

/** Something outside the grant gets its own change set, so it comes back as its own card. */
export function outsideSession(jobId: string, n: string): string {
  return `job:${jobId}:outside:${n}`;
}

/** For handlers that need to say which job called them. */
export function jobIdOf(ctx: Pick<HandlerContext, "origin">): string | null {
  return ctx.origin.jobId ?? null;
}
