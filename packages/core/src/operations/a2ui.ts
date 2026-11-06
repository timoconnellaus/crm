// A2UI cards (ADR 0346). `a2ui.show` is the model's way to send a card; `a2ui.produce` runs a saved
// producer, with no model; `a2ui.act` is what a button on a model's or producer's card calls.
//
// Why `a2ui.act` exists: the gate lets a human do anything their role allows, so a button a model
// wrote cannot simply call the operation as the viewer. A prompt-injected "Open" button could then
// delete a record with one press and no review. Pressing it runs the operation as the assistant,
// with the viewer's permissions, so the approval policy applies exactly as if the assistant had
// called it. Only the host's own cards call operations directly.
import {
  A2UI_CATALOGUE_VERSION,
  a2uiPartSchema,
  catalogueGuide,
  operationNameSchema,
  prepareCard,
  producerRef,
  producerSupported,
} from "@relationship-os/agent-a2ui";
import { z } from "zod";
import { CARD_STATUS } from "../assistant/events.ts";
import { producers } from "../assistant/producers.ts";
import { ConfigError, ForbiddenError, NotFoundError, PendingApprovalError } from "../errors.ts";
import type { CodeCaller } from "../extensions/host.ts";
import { requireHost } from "../extensions/install.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { pluginProducer, pluginProducers } from "../plugins/resolve.ts";
import { loadGeneralSettings } from "../settings.ts";

const cardResultSchema = z.object({
  status: z.literal(CARD_STATUS),
  part: a2uiPartSchema,
  /** Where it landed, when the card was posted in the thread. */
  seq: z.number().optional(),
});

/** A model may send the card as a JSON string; anything unreadable falls back to its words. */
function cardInput(card: unknown): unknown {
  if (typeof card !== "string") return card;
  try {
    return JSON.parse(card) as unknown;
  } catch {
    return card;
  }
}

export const a2uiShow = defineOperation({
  name: "a2ui.show",
  description: `Show the person a card in the chat: tasks with checkboxes, records, deals, numbers, a form or choices, instead of a long list in words. Buttons call operations with the person's permissions, under the approval policy. The app draws only the components below; a card it cannot draw shows your text instead, and the result says why. The result gives you the card's text, numbered, so you can refer to "the second task". Writes nothing.

${catalogueGuide()}

Example: { "a2ui": ${A2UI_CATALOGUE_VERSION}, "root": { "type": "taskList", "title": "Due this week", "tasks": [{ "id": "tsk_…", "title": "Send order form", "dueLabel": "Due Fri 7 Nov" }], "viewAll": "/tasks" } }`,
  input: z.object({
    card: z.unknown().describe("The card: { a2ui, root }"),
    text: z
      .string()
      .trim()
      .min(1)
      .max(4_000)
      .describe("The same answer in plain words, shown if the card cannot be drawn"),
  }),
  output: cardResultSchema,
  permission: "records:read",
  risk: "read",
  actors: ["assistant"],
  redact: ["card"],
  mcp: { curated: true, title: "Show a card", toolName: "show_card" },
  async handler(input) {
    return {
      status: CARD_STATUS,
      part: prepareCard(cardInput(input.card), { source: "model", text: input.text }),
    };
  },
});

function producerCaller(ctx: HandlerContext): CodeCaller {
  if (ctx.actor === "extension") throw new ForbiddenError("Extensions do not run producers");
  return {
    actor: ctx.actor,
    user: ctx.user,
    origin: {
      surface: ctx.origin.surface === "ui" ? "ui" : "mcp",
      ...(ctx.origin.clientId ? { clientId: ctx.origin.clientId } : {}),
      ...(ctx.origin.clientName ? { clientName: ctx.origin.clientName } : {}),
      ...(ctx.origin.sessionId ? { sessionId: ctx.origin.sessionId } : {}),
    },
    ...(ctx.grantedPermissions ? { grantedPermissions: [...ctx.grantedPermissions] } : {}),
  };
}

// First-party cards are listed here. A plugin's are the viewer's own and can change with each
// install, so they are not in this fixed description: they reach the model through the skills
// block of its instructions, and `a2ui.producers` lists them all.
const PRODUCE_DESCRIPTION = `Show a saved card: a script that reads the CRM as the viewer and returns a card with no model call, so it is fast, free and the same every time. Prefer it to show_card when one fits. Read-only: it cannot change anything or show what the viewer cannot see. Plugins add more: call_operation a2ui.producers lists every one you can use. Saved cards:
${producers
  .list()
  .map((p) => `- ${p.name}: ${p.description}`)
  .join("\n")}`;

export const a2uiProduce = defineOperation({
  name: "a2ui.produce",
  description: PRODUCE_DESCRIPTION,
  input: z.object({
    producer: z.string().min(1).max(120).describe("The saved card's name"),
    version: z.number().int().min(1).optional().describe("A version (default: the newest)"),
    input: z.record(z.string(), z.unknown()).default({}).describe("What the saved card takes"),
    post: z
      .boolean()
      .default(false)
      .describe("Also post it in your thread, for routines and app buttons. Not for the assistant"),
  }),
  output: cardResultSchema,
  permission: "records:read",
  risk: "read",
  actors: ["human", "assistant", "mcp", "automation"],
  mcp: { curated: true, title: "Show a saved card", toolName: "a2ui_produce" },
  async handler(input, ctx) {
    const producer =
      producers.get(input.producer, input.version) ??
      (await pluginProducer(ctx.db, ctx.user, input.producer));
    if (!producer) throw new NotFoundError("saved card", input.producer);
    const ref = producerRef(producer);
    const words = `${producer.description.split(".")[0]}.`;
    let part: z.infer<typeof a2uiPartSchema>;
    if (!producerSupported(producer)) {
      // ADR 0346: a producer for a newer catalogue than this app falls back to text.
      part = prepareCard(
        { a2ui: producer.catalogue },
        { source: "producer", producer: ref, text: words },
      );
    } else {
      const parsed = (producer.input ?? z.record(z.string(), z.unknown())).parse(input.input);
      const settings = await loadGeneralSettings(ctx.db);
      const run = await requireHost(ctx).runProducer({
        ref,
        source: producer.source,
        input: parsed,
        now: ctx.now,
        timezone: settings.timezone || "UTC",
        caller: producerCaller(ctx),
      });
      part = run.ok
        ? prepareCard(run.value, { source: "producer", producer: ref, text: words })
        : {
            type: "a2ui",
            source: "producer",
            producer: ref,
            document: null,
            fallback: words,
            problems: [run.error?.message ?? "The saved card failed"],
          };
    }
    if (!input.post || ctx.actor === "assistant") return { status: CARD_STATUS, part };
    if (!ctx.assistantThreads) {
      throw new ConfigError("The assistant is not available on this deployment");
    }
    const posted = await ctx.assistantThreads.postCard(ctx.user.id, part);
    return { status: CARD_STATUS, part, seq: posted.seq };
  },
});

/** Operations a card's button may never reach, even though the assistant could call some. */
const NOT_FROM_A_CARD = /^(a2ui|approval|code|extension)\./;

export const a2uiAct = defineOperation({
  name: "a2ui.act",
  description:
    "Runs the operation behind a button on a card the model or a saved producer wrote, for the " +
    "person who pressed it. It runs as the assistant with that person's permissions, so the " +
    "approval policy applies: anything that needs review is queued, not applied. People only: " +
    "the app calls it, a model never does.",
  input: z.object({
    operation: operationNameSchema,
    input: z.record(z.string(), z.unknown()).default({}),
    label: z.string().max(60).describe("The button pressed"),
    threadId: z.string().max(80).optional().describe("The thread the card is in"),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("done"), result: z.unknown() }),
    z.object({
      status: z.literal("pending_approval"),
      actionId: z.string(),
      changeSetId: z.string(),
      message: z.string(),
    }),
  ]),
  // The operation it runs checks its own permission.
  permission: "records:read",
  risk: "write",
  // Never queued itself: the operation it runs goes through the gate on its own.
  bookkeeping: true,
  actors: ["human"],
  redact: ["input"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (NOT_FROM_A_CARD.test(input.operation)) {
      throw new ForbiddenError(`A card's button cannot call ${input.operation}`);
    }
    try {
      const result = await ctx.pipeline.invoke(input.operation, input.input, {
        actor: "assistant",
        user: ctx.user,
        origin: {
          surface: "assistant",
          ...(input.threadId ? { sessionId: input.threadId } : {}),
        },
        reason: `Pressed "${input.label}" on a card in the assistant`,
      });
      return { status: "done" as const, result };
    } catch (error) {
      if (!(error instanceof PendingApprovalError)) throw error;
      const { actionId, changeSetId, message } = error.pending;
      return { status: "pending_approval" as const, actionId, changeSetId, message };
    }
  },
});

export const a2uiProducers = defineOperation({
  name: "a2ui.producers",
  description:
    "Every saved card you can use: the app's own and those from plugins you have, with what " +
    "input each takes. Read-only.",
  input: z.object({}),
  output: z.object({
    items: z.array(
      z.object({ name: z.string(), description: z.string(), source: z.enum(["app", "plugin"]) }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human", "assistant", "mcp"],
  mcp: { title: "List saved cards", idempotent: true },
  async handler(_input, ctx) {
    return {
      items: [
        ...producers.list().map((p) => ({
          name: p.name,
          description: p.description,
          source: "app" as const,
        })),
        ...(await pluginProducers(ctx.db, ctx.user)).map((p) => ({
          name: p.name,
          description: p.description,
          source: "plugin" as const,
        })),
      ],
    };
  },
});

export const a2uiOperations = [a2uiShow, a2uiProduce, a2uiProducers, a2uiAct] as const;
