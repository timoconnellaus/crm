// Agent profiles (ADR 0344): named kinds of agent, with instructions, a default grant, a budget and
// a model role. Shipped ones are here; plugins (W7) register theirs in `agentProfiles` when they
// install. A profile names a role, never a model.
import type { JobBudget } from "@relationship-os/agent-core";
import type { ModelRole } from "../ai/roles.ts";

export interface AgentProfile {
  /** What it is started by: `researcher`, or `<plugin>.<name>`. */
  name: string;
  label: string;
  /** For the assistant and the Agent profiles page. */
  description: string;
  instructions: string;
  /** Default: `assistant.subagent`. */
  role?: ModelRole;
  defaultGrant: {
    operations: readonly string[];
    caps: { changes: number; notes: number; tasks: number };
    expiresInHours: number;
  };
  budget: JobBudget;
  /** Where it came from: `shipped`, or the plugin that added it. */
  source: string;
}

export interface AgentProfileRegistry {
  list(): AgentProfile[];
  get(name: string): AgentProfile | undefined;
  register(profile: AgentProfile): void;
  unregister(name: string): void;
}

export function createAgentProfileRegistry(shipped: readonly AgentProfile[]): AgentProfileRegistry {
  const profiles = new Map(shipped.map((p) => [p.name, p]));
  return {
    list: () => [...profiles.values()],
    get: (name) => profiles.get(name),
    register(profile) {
      profiles.set(profile.name, profile);
    },
    unregister(name) {
      profiles.delete(name);
    },
  };
}

const READ_RECORDS = [
  "search.global",
  "person.get",
  "person.list",
  "organisation.get",
  "organisation.list",
  "record.get",
  "record.list",
  "activity.listForRecord",
];

const WEB = ["connection.list", "integration.types", "integration.call"];

export const SHIPPED_AGENT_PROFILES: readonly AgentProfile[] = [
  {
    name: "researcher",
    label: "Researcher",
    description:
      "Finds out about the records it is given, with web search where connected, and fills in what is missing.",
    instructions:
      "Work through the records one at a time. Read each one, find what is missing, and fill empty fields with what you can support. Update one record per call, with your source as the reason. If a value already on the record looks wrong, propose the change: it is set aside for the person with your reason. Leave a field empty rather than guess.",
    defaultGrant: {
      operations: [
        ...READ_RECORDS,
        ...WEB,
        "organisation.update",
        "person.update",
        "record.update",
        "activity.log",
      ],
      caps: { changes: 100, notes: 50, tasks: 0 },
      expiresInHours: 8,
    },
    budget: { steps: 200, minutes: 30, spendUsd: 2 },
    source: "shipped",
  },
  {
    name: "drafter",
    label: "Drafter",
    description:
      "Writes drafts for the records it is given, in the person's writing style. Nothing is sent without the person.",
    instructions:
      "Write what the brief asks for, in the person's writing style if you remember one. Read the record and its timeline first, so each draft says something true and specific. Anything that sends is set aside for the person: say so in your report.",
    defaultGrant: {
      operations: [...READ_RECORDS, ...WEB, "activity.log", "task.create"],
      caps: { changes: 0, notes: 50, tasks: 20 },
      expiresInHours: 8,
    },
    budget: { steps: 100, minutes: 15, spendUsd: 1 },
    source: "shipped",
  },
  {
    name: "importer",
    label: "Importer",
    description:
      "Cleans up and adds records from a list. Every new record and changed value is set aside for review.",
    instructions:
      "Go through the list in the brief. Search for each entry first, so you never add a duplicate. Fill empty fields on records you find. New records and changed values are set aside for the person, one per call, so they can approve each row.",
    defaultGrant: {
      operations: [
        ...READ_RECORDS,
        "person.create",
        "person.update",
        "organisation.create",
        "organisation.update",
      ],
      caps: { changes: 500, notes: 0, tasks: 0 },
      expiresInHours: 24,
    },
    budget: { steps: 400, minutes: 60, spendUsd: 4 },
    source: "shipped",
  },
  {
    name: "analyst",
    label: "Analyst",
    description: "Reads across records to answer a question. It changes nothing.",
    instructions:
      "Answer the question in the brief from the CRM's data. Read what you need, count rather than estimate, and report what you found with the numbers and the records behind them. Say plainly what you could not find.",
    defaultGrant: {
      operations: [...READ_RECORDS, "query.sql", "record.count", "record.groups", "task.list"],
      caps: { changes: 0, notes: 0, tasks: 0 },
      expiresInHours: 4,
    },
    budget: { steps: 60, minutes: 10, spendUsd: 1 },
    source: "shipped",
  },
];

/** Every profile this deployment can start. */
export const agentProfiles: AgentProfileRegistry =
  createAgentProfileRegistry(SHIPPED_AGENT_PROFILES);
