// A routine's step can start an agent (ADR 0343, ADR 0344): what `registerRoutineAgentStarter` is
// for. Delivery runs here in ros-app, where the objects are. The agent starts as the routine, so
// its grant is checked against what an automation may do, and it runs in the background. A brief
// names no records, so nothing it does applies without review; the default profile only reads.

import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type CoreOutput,
  cardOf,
  invokeByName,
  parseFloor,
  ROLES,
  type Role,
  registerRoutineAgentStarter,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { aiContextFor } from "../ai.ts";
import { agentJobsFor, type OperationsEnv } from "../operations.ts";

/** A routine's brief is one person's words: its first line names the agent. */
function titleOf(brief: string): string {
  const line = brief.split("\n")[0]?.trim() ?? "";
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
}

registerRoutineAgentStarter(async ({ userId, brief, profile }) => {
  const appEnv = env as unknown as OperationsEnv;
  const db = createCrmDb(appEnv.DB);
  const row = await db.query
    .selectFrom("core_user")
    .select(["id", "email", "name", "role"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  const user: ActingUser = {
    ...row,
    role: (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : "viewer",
  };
  const agentJobs = agentJobsFor(appEnv);
  const out = (await invokeByName(
    "agent.start",
    { title: titleOf(brief), brief, profile: profile ?? "analyst" },
    {
      actor: "automation",
      user,
      origin: { surface: "automation", automationId: "routine" },
      db,
      floor: parseFloor(appEnv.APPROVAL_FLOOR),
      ...aiContextFor(appEnv, db),
      ...(agentJobs ? { agentJobs } : {}),
    },
  )) as CoreOutput<"agent.start">;
  if (out.status === "refused") return { text: out.message };
  const card = cardOf(out);
  return card ? { text: card.fallback, cards: [card] } : { text: `${titleOf(brief)} has started.` };
});
