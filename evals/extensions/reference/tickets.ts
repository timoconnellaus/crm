// Reference answer for the `ticket-tool` prompt: an object and a read-only tool over it.
import { defineExtension, defineTool, z } from "@crm/sdk";

const countOpenTickets = defineTool({
  description: "Count the open tickets of one organisation. Read-only.",
  risk: "read",
  input: z.object({ organisationId: z.string().min(1) }),
  output: z.object({ organisationId: z.string(), open: z.number() }),
  async handler({ organisationId }, ctx) {
    const page = await ctx.crm.call<{ items: unknown[] }>("record.list", {
      object: "tickets.ticket",
      filter: {
        and: [
          { field: "organisation", op: "eq", value: organisationId },
          { field: "status", op: "eq", value: "open" },
        ],
      },
      limit: 200,
    });
    return { organisationId, open: page.items.length };
  },
});

export default defineExtension({
  id: "tickets",
  version: "1.0.0",
  contractVersion: 1,
  label: "Tickets",
  permissions: { read: ["organisation"], modules: ["crm"] },
  objects: {
    ticket: {
      label: "Ticket",
      plural: "Tickets",
      icon: "ticket",
      titleField: "subject",
      fields: {
        subject: { type: "text", label: "Subject", required: true },
        status: {
          type: "select",
          label: "Status",
          options: [
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
          ],
        },
        organisation: { type: "relation", label: "Organisation", to: "organisation" },
      },
    },
  },
  tools: { countOpenTickets },
});
