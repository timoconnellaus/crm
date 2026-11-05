// The grader's view of the CRM over MCP: calling operations (as their curated tool when the server
// lists one, else through call_operation), seeding the test records, and reading automations.
import { toolNameFor } from "@relationship-os/evals-mcp/lib/grading.ts";
import { addDays } from "@relationship-os/evals-mcp/lib/harness.ts";
import { isPending, type McpSession, parseResult } from "@relationship-os/evals-mcp/lib/mcp.ts";
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

/** The id of the first stage of a type (deals.stage records). */
export async function stageOfType(crm: CrmClient, type: string): Promise<string> {
  const page = await crm.call<{ items?: { id: string }[] }>("record.list", {
    object: "deals.stage",
    filter: { field: "type", op: "eq", value: type },
    sort: { field: "position", direction: "asc" },
    limit: 1,
  });
  const id = page.items?.[0]?.id;
  if (!id) throw new Error(`no deals.stage of type ${type}: is the Deals extension installed?`);
  return id;
}

export interface SeededRecord {
  object: string;
  id: string;
}

/** Creates a case's test record; returns its reference. */
export async function seedRecord(
  crm: CrmClient,
  seed: SeedSpec,
  context: { userId: string; today: string; suffix: string },
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
  if (seed.stageType) values.stage = await stageOfType(crm, seed.stageType);
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
