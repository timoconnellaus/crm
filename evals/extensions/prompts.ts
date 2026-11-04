// The 10 natural-language authoring prompts of the stage 3 extensions eval
// (docs/stages/03-extensions.md, criterion 9). For each one an MCP client model writes an
// extension over MCP; it passes when the model proposed it successfully, the working copy passes
// `extension_check`, and the proposed manifest has what the user asked for (`expect`).
//
// Extension ids are unique per run: the harness appends the run's generated word to `idBase`
// ("renewal" + "varodin") and tells the model to use that id, so runs never collide in the
// extension workspace. `reference/<idBase>.ts` is a known-good answer to each prompt; the unit
// tests grade it, and smoke.ts writes it to a real deployment and checks it.
import {
  collector,
  fieldsOf,
  fieldsOn,
  type Manifest,
  mentions,
  missingField,
  missingOptions,
  type NamedField,
  objectsOf,
  references,
} from "./lib/manifest.ts";

export interface AuthoringPrompt {
  id: string;
  title: string;
  /** What the prompt exercises, for the report. */
  covers: string[];
  /** The extension id before the run's word is appended; also the reference file's name. */
  idBase: string;
  /** What the user asks for. */
  request: string;
  /** Failure messages for the proposed manifest; empty when it has what was asked for. */
  expect(manifest: Manifest): string[];
}

/** The extension id the model is told to use: `idBase` + the run's word, lower case. */
export function extensionIdFor(prompt: AuthoringPrompt, slug: string): string {
  return `${prompt.idBase}${slug.toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 30);
}

/** The user message: the request, plus the id to use and that it should end up proposed. */
export function promptText(prompt: AuthoringPrompt, extensionId: string): string {
  return (
    `${prompt.request}\n\nDo it with a CRM extension whose id is \`${extensionId}\`. ` +
    "Make sure it passes check, then propose it for approval."
  );
}

const ofType = (fields: NamedField[], types: string[], pattern?: RegExp) =>
  fields.find((f) => types.includes(f.type) && (!pattern || mentions(f, pattern)));

/** Checks for a select/multiSelect with the options asked for. */
function choiceField(
  where: string,
  fields: NamedField[],
  type: "select" | "multiSelect",
  pattern: RegExp,
  options: string[],
): string[] {
  const field = ofType(fields, [type], pattern) ?? ofType(fields, [type]);
  if (!field) return [missingField(where, `${type} field mentioning ${pattern}`, fields)];
  const missing = missingOptions(field, options);
  return missing.length ? [`${where}.${field.name} lacks the option(s) ${missing.join(", ")}`] : [];
}

/** The extension object whose name, label or plural matches, or the only one there is. */
function objectNamed(manifest: Manifest, pattern: RegExp) {
  const objects = objectsOf(manifest);
  return (
    objects.find(
      (o) => pattern.test(o.name) || pattern.test(o.label ?? "") || pattern.test(o.plural ?? ""),
    ) ?? (objects.length === 1 ? objects[0] : undefined)
  );
}

const noObject = (manifest: Manifest, what: string) =>
  `no ${what} object (objects: ${
    objectsOf(manifest)
      .map((o) => o.name)
      .join(", ") || "none"
  })`;

export const prompts: AuthoringPrompt[] = [
  {
    id: "renewal-date",
    title: "A renewal date on organisations",
    covers: ["fields on a core object", "date"],
    idBase: "renewal",
    request: "Add a renewal date to organisations.",
    expect(m) {
      const fields = fieldsOn(m, "organisation");
      return ofType(fields, ["date", "datetime"], /renew/i)
        ? []
        : [missingField("organisation", "date field mentioning renewal", fields)];
    },
  },
  {
    id: "projects",
    title: "A Projects object with a status, budget and remaining-budget formula",
    covers: ["new object", "relation", "select", "currency", "formula"],
    idBase: "projects",
    request:
      "Create a Projects object linked to organisations, with a status, a budget, the amount " +
      "spent so far, and a formula for the remaining budget.",
    expect(m) {
      const project = objectNamed(m, /project/i);
      if (!project) return [noObject(m, "Projects")];
      const fields = fieldsOf(project);
      const where = `object ${project.name}`;
      const { failures, need } = collector();
      need(
        fields.some((f) => f.type === "relation" && f.to === "organisation"),
        missingField(where, 'relation to "organisation"', fields),
      );
      need(ofType(fields, ["select"]), missingField(where, "select field (status)", fields));
      const budget = ofType(fields, ["currency"], /budget/i) ?? ofType(fields, ["currency"]);
      if (need(budget, missingField(where, "currency field (budget)", fields)) && budget) {
        need(
          fields.some((f) => f.type === "formula" && references(f.expression, budget.name)),
          missingField(where, `formula field that uses ${budget.name}`, fields),
        );
      }
      return failures;
    },
  },
  {
    id: "days-until-renewal",
    title: "A renewal date and a days-until-renewal formula",
    covers: ["date", "formula", "dateDiff", "today()"],
    idBase: "renewaldays",
    request:
      "Add a contract renewal date to organisations, and a formula field showing the number of " +
      "days until renewal.",
    expect(m) {
      const fields = fieldsOn(m, "organisation");
      const date = ofType(fields, ["date", "datetime"], /renew/i) ?? ofType(fields, ["date"]);
      if (!date) return [missingField("organisation", "date field for the renewal", fields)];
      const formula = fields.find(
        (f) => f.type === "formula" && references(f.expression, date.name),
      );
      if (!formula) {
        return [missingField("organisation", `formula field that uses ${date.name}`, fields)];
      }
      return /today\s*\(\s*\)/.test(formula.expression ?? "")
        ? []
        : [`organisation.${formula.name} does not count from today(): ${formula.expression}`];
    },
  },
  {
    id: "task-priority",
    title: "A priority select on tasks",
    covers: ["fields on task", "select options"],
    idBase: "priority",
    request: "Give tasks a priority: low, medium, high or urgent.",
    expect: (m) =>
      choiceField("task", fieldsOn(m, "task"), "select", /priorit/i, [
        "low",
        "medium",
        "high",
        "urgent",
      ]),
  },
  {
    id: "lead-source",
    title: "A lead-source select on people",
    covers: ["fields on person", "select options"],
    idBase: "leadsource",
    request:
      "We want to track where each person came from. Add a lead source to people, with the " +
      "options website, referral, event, cold outreach and partner.",
    expect: (m) =>
      choiceField("person", fieldsOn(m, "person"), "select", /source/i, [
        "website",
        "referral",
        "event",
        "cold outreach",
        "partner",
      ]),
  },
  {
    id: "vendors",
    title: "A Vendors object with contact fields",
    covers: ["new object", "url", "email", "phone", "date", "titleField"],
    idBase: "vendors",
    request:
      "Create a Vendors object to keep track of our suppliers: the vendor's name, website, " +
      "contact email, phone number and contract end date.",
    expect(m) {
      const vendor = objectNamed(m, /vendor|supplier/i);
      if (!vendor) return [noObject(m, "Vendors")];
      const fields = fieldsOf(vendor);
      const where = `object ${vendor.name}`;
      const { failures, need } = collector();
      const title = fields.find((f) => f.name === vendor.titleField);
      need(
        title && (title.type === "text" || title.type === "longText"),
        `${where} titleField ${vendor.titleField ?? "(none)"} is not a text field`,
      );
      for (const type of ["url", "email", "phone", "date"]) {
        need(ofType(fields, [type]), missingField(where, `${type} field`, fields));
      }
      return failures;
    },
  },
  {
    id: "interests",
    title: "A multi-select of interests on people",
    covers: ["fields on person", "multiSelect"],
    idBase: "interests",
    request:
      "Add interests to people, where several can be picked: product updates, events, webinars " +
      "and partnerships.",
    expect: (m) =>
      choiceField("person", fieldsOn(m, "person"), "multiSelect", /interest/i, [
        "product updates",
        "events",
        "webinars",
        "partnerships",
      ]),
  },
  {
    id: "ticket-tool",
    title: "A Tickets object and a read-only tool that counts open tickets",
    covers: ["new object", "tool", "risk read", "ctx.crm", "permissions.modules"],
    idBase: "tickets",
    request:
      "Create a Tickets object with a subject, a status (open or closed) and the organisation it " +
      "belongs to, plus a read-only tool that counts the open tickets of a given organisation.",
    expect(m) {
      const { failures, need } = collector();
      const ticket = objectNamed(m, /ticket/i);
      if (need(ticket, noObject(m, "Tickets")) && ticket) {
        const fields = fieldsOf(ticket);
        const where = `object ${ticket.name}`;
        failures.push(...choiceField(where, fields, "select", /status/i, ["open", "closed"]));
        need(
          fields.some((f) => f.type === "relation" && f.to === "organisation"),
          missingField(where, 'relation to "organisation"', fields),
        );
      }
      const tools = Object.entries(m.tools ?? {});
      const tool = tools.find(
        ([name, t]) => /count/i.test(name) || /count/i.test(t.description ?? ""),
      );
      if (
        need(tool, `no tool that counts (tools: ${tools.map(([n]) => n).join(", ") || "none"})`) &&
        tool
      ) {
        const [name, spec] = tool;
        need(
          spec.risk === "read",
          `tool ${name} has risk ${spec.risk ?? "(default write)"}, not read`,
        );
        const input = Object.keys((spec.inputSchema?.properties as object | undefined) ?? {});
        need(
          input.some((p) => /organi[sz]ation/i.test(p)),
          `tool ${name} takes no organisation input (input: ${input.join(", ") || "none"})`,
        );
      }
      need(
        m.permissions?.modules?.includes("crm"),
        `permissions.modules does not include "crm" (has: ${m.permissions?.modules?.join(", ") || "none"})`,
      );
      return failures;
    },
  },
  {
    id: "linkedin-url",
    title: "A LinkedIn URL field on people",
    covers: ["fields on person", "url"],
    idBase: "linkedin",
    request: "Add a LinkedIn profile URL to people.",
    expect(m) {
      const fields = fieldsOn(m, "person");
      return ofType(fields, ["url"], /linked\s*in/i)
        ? []
        : [missingField("person", "url field mentioning LinkedIn", fields)];
    },
  },
  {
    id: "discount",
    title: "A contract value, a discount percent and a discounted-value formula",
    covers: ["currency", "percent", "formula over two fields"],
    idBase: "discount",
    request:
      "On organisations, add an annual contract value, a discount percentage, and a formula for " +
      "the contract value after the discount.",
    expect(m) {
      const fields = fieldsOn(m, "organisation");
      const { failures, need } = collector();
      const value = ofType(fields, ["currency", "number"], /value|contract|acv/i);
      const percent = ofType(fields, ["percent"]);
      need(value, missingField("organisation", "currency field for the contract value", fields));
      need(percent, missingField("organisation", "percent field for the discount", fields));
      if (value && percent) {
        need(
          fields.some(
            (f) =>
              f.type === "formula" &&
              references(f.expression, value.name) &&
              references(f.expression, percent.name),
          ),
          missingField(
            "organisation",
            `formula field that uses ${value.name} and ${percent.name}`,
            fields,
          ),
        );
      }
      return failures;
    },
  },
];
