// The grader's view of the CRM over MCP: calling operations (as their curated tool when the server
// lists one, else through call_operation), seeding the test records, and reading automations.
import { toolNameFor } from "@crm/evals-mcp/lib/grading.ts";
import { addDays } from "@crm/evals-mcp/lib/harness.ts";
import { isPending, type McpSession, parseResult } from "@crm/evals-mcp/lib/mcp.ts";
import type { SeedSpec } from "../prompts.ts";

export const GRADER_REASON = "Automations eval grader";

export class OperationFailed extends Error {
  override name = "OperationFailed";
  readonly operation: string;
  readonly result: unknown;
  constructor(operation: string, result: unknown, text: string) {
    super(`${operation} failed: ${text.slice(0, 400)}`);
    this.operation = operation;
    this.result = result;
  }
}

/** Operations over one MCP session. Remembers the tool list to pick curated tools. */
export class CrmClient {
  #tools: Promise<Set<string>> | null = null;
  readonly session: McpSession;
  constructor(session: McpSession) {
    this.session = session;
  }

  tools(): Promise<Set<string>> {
    this.#tools ??= this.session.listTools().then((list) => new Set(list.map((t) => t.name)));
    return this.#tools;
  }

  /** Runs `operation`; throws OperationFailed on an error and on a queued (pending) write. */
  async call<T = Record<string, unknown>>(
    operation: string,
    input: Record<string, unknown> = {},
    options: { write?: boolean } = {},
  ): Promise<T> {
    const tool = toolNameFor(operation);
    const curated = (await this.tools()).has(tool);
    const answer = curated
      ? await this.session.callTool(tool, {
          ...input,
          ...(options.write ? { reason: GRADER_REASON } : {}),
        })
      : await this.session.callTool("call_operation", {
          name: operation,
          input,
          ...(options.write ? { reason: GRADER_REASON } : {}),
        });
    const result = parseResult(answer.text);
    if (answer.isError) throw new OperationFailed(operation, result, answer.text);
    if (options.write && isPending(result)) {
      throw new OperationFailed(
        operation,
        result,
        "it was queued for approval: the grader needs the org's approval policy on Balanced " +
          "(single creates and updates apply immediately)",
      );
    }
    return (result ?? {}) as T;
  }
}

/** The eval user's id, from user.list by email. */
export async function userIdByEmail(crm: CrmClient, email: string): Promise<string> {
  const page = await crm.call<{ items?: { id: string; email?: string }[] }>("user.list", {
    filter: { field: "email", op: "eq", value: email },
    limit: 1,
  });
  const id = page.items?.[0]?.id;
  if (!id) throw new Error(`user.list found no user with email ${email}`);
  return id;
}

/** The Deals extension's default pipeline (the seeded value of its Default pipeline setting). */
export const DEFAULT_PIPELINE = "New business";

type Row = { id: string; values?: Record<string, unknown> };

/**
 * The pipeline fixture deals go in: "New business" (the Deals default, whose first stage has no
 * stage rules), else the first by order; null when there are none.
 */
export async function fixturePipeline(crm: CrmClient): Promise<string | null> {
  const page = await crm.call<{ items?: Row[] }>("record.list", {
    object: "deals.pipeline",
    sort: { field: "position", direction: "asc" },
    limit: 50,
  });
  const items = page.items ?? [];
  return (items.find((p) => p.values?.name === DEFAULT_PIPELINE) ?? items[0])?.id ?? null;
}

export interface FixtureStage {
  id: string;
  /** The deal fields required to enter it (its stage rules). */
  requiredFields: string[];
}

const fieldList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value.startsWith("[")) return [];
  try {
    return fieldList(JSON.parse(value));
  } catch {
    return [];
  }
};

/** The first stage of a type (deals.stage records), within `pipeline` when given. */
export async function stageOfType(
  crm: CrmClient,
  type: string,
  pipeline?: string | null,
): Promise<FixtureStage> {
  const byType = { field: "type", op: "eq", value: type };
  const page = await crm.call<{ items?: Row[] }>("record.list", {
    object: "deals.stage",
    filter: pipeline ? { and: [byType, { field: "pipeline", op: "eq", value: pipeline }] } : byType,
    sort: { field: "position", direction: "asc" },
    limit: 1,
  });
  const stage = page.items?.[0];
  if (!stage) throw new Error(`no deals.stage of type ${type}: is the Deals extension installed?`);
  return { id: stage.id, requiredFields: fieldList(stage.values?.requiredFields) };
}

export interface SeededRecord {
  object: string;
  id: string;
}

type SeedContext = { userId: string; today: string; suffix: string };

/** One eval organisation per run (per grader client), for deals whose stage requires one. */
const dealOrgs = new WeakMap<CrmClient, Promise<string>>();

function dealOrg(crm: CrmClient, suffix: string): Promise<string> {
  let org = dealOrgs.get(crm);
  if (!org) {
    org = crm
      .call<{ id: string }>(
        "organisation.create",
        { name: `Eval Deals Ltd ${suffix}` },
        {
          write: true,
        },
      )
      .then((o) => o.id);
    dealOrgs.set(crm, org);
  }
  return org;
}

/**
 * Fills the deal fields the stage requires (its stage rules) that the case left empty, so the
 * fixture can enter it on a fresh or a seeded database. A lost stage always needs a lost reason.
 */
async function fillStageRules(
  crm: CrmClient,
  stage: FixtureStage,
  type: string,
  values: Record<string, unknown>,
  context: SeedContext,
): Promise<void> {
  const required = new Set(stage.requiredFields);
  if (type === "lost") required.add("lostReason");
  const fills: Record<string, () => unknown> = {
    organisation: () => dealOrg(crm, context.suffix),
    owner: () => context.userId,
    value: () => 10000,
    expectedClose: () => addDays(context.today, 30),
    nextStep: () => "Eval next step",
    nextStepDate: () => addDays(context.today, 7),
    source: () => "other",
    lostReason: () => "other",
  };
  for (const field of required) {
    const fill = fills[field];
    if (fill && (values[field] === undefined || values[field] === null)) {
      values[field] = await fill();
    }
  }
}

/** Creates a case's test record; returns its reference. */
export async function seedRecord(
  crm: CrmClient,
  seed: SeedSpec,
  context: SeedContext,
): Promise<SeededRecord> {
  const values: Record<string, unknown> = { ...seed.values };
  for (const field of seed.self ?? []) values[field] = context.userId;
  for (const [field, days] of Object.entries(seed.daysFromToday ?? {})) {
    values[field] = addDays(context.today, days);
  }
  const label = (value: unknown) => `${String(value)} ${context.suffix}`;
  if (seed.object === "person") {
    values.displayName = label(values.displayName);
    const person = await crm.call<{ id: string }>("person.create", values, { write: true });
    return { object: "person", id: person.id };
  }
  if (seed.object === "organisation") {
    values.name = label(values.name);
    const org = await crm.call<{ id: string }>("organisation.create", values, { write: true });
    return { object: "organisation", id: org.id };
  }
  values.name = label(values.name);
  if (seed.stageType) {
    // The stage and its pipeline together: a stage of another pipeline is refused.
    const pipeline = await fixturePipeline(crm);
    const stage = await stageOfType(crm, seed.stageType, pipeline);
    if (pipeline) values.pipeline = pipeline;
    values.stage = stage.id;
    await fillStageRules(crm, stage, seed.stageType, values, context);
  }
  const record = await crm.call<{ id: string }>(
    "record.create",
    { object: seed.object, values },
    { write: true },
  );
  return { object: seed.object, id: record.id };
}

export interface AutomationListing {
  id: string;
  key?: string;
  label?: string;
  triggerType?: string;
  status?: string;
}

/** The installed automations of an extension (empty until its proposal is approved). */
export async function automationsOf(
  crm: CrmClient,
  extensionId: string,
): Promise<AutomationListing[]> {
  const list = await crm.call<{ items?: AutomationListing[] }>("automation.list", { extensionId });
  return (list.items ?? []).filter((item) => item.id.startsWith(`${extensionId}.`));
}
