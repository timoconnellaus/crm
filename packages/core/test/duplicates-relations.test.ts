// Stage 16 (ADR 0247): a merge re-points extension relations to the survivor, generically from
// core_extension_fields: Deals' deal.organisation and participant.person, and a fixture
// extension declaring single and many relations to people (acceptance criterion 6).
import { env } from "cloudflare:workers";
import deals from "@relationship-os/extension-deals";
import { toManifest } from "@relationship-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke } from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

let member: ActingUser;
let ext: string;

beforeAll(async () => {
  await createUser("admin");
  member = await createUser("member");
  // What extension.install leaves behind for Deals, without the sandbox (as deals-dashboards).
  const dealsManifest = toManifest(deals);
  await reconcile(dealsManifest);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO core_user (id, name, email, email_verified, created_at, updated_at, role, kind) VALUES ('extension:deals', 'Deals', 'deals@extensions.crm.invalid', 0, ?, ?, 'member', 'extension')",
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES ('deals', 'shipped', 'active', ?, 'test', ?, 'extension:deals', ?, ?)",
  )
    .bind(dealsManifest.version, JSON.stringify(dealsManifest), now, now)
    .run();
  ext = extId("dup");
  await reconcile(
    manifest(ext, {
      objects: {
        ticket: {
          label: "Ticket",
          plural: "Tickets",
          titleField: "summary",
          fields: {
            summary: { type: "text", label: "Summary", required: true },
            contact: { type: "relation", label: "Contact", to: "person" },
            watchers: { type: "relation", label: "Watchers", to: "person", many: true },
          },
        },
      },
    }),
  );
});

async function values(object: string, id: string) {
  return (await invoke("record.get", { object, id }, context(member))).values as Record<
    string,
    unknown
  >;
}

describe("merge re-points extension relations", () => {
  it("deals follow a merged organisation", async () => {
    const survivor = await invoke("organisation.create", { name: unique("Org ") }, context(member));
    const merged = await invoke("organisation.create", { name: unique("Org ") }, context(member));
    const deal = await invoke(
      "record.create",
      { object: "deals.deal", values: { name: unique("Deal "), organisation: merged.id } },
      context(member),
    );
    await invoke(
      "organisation.merge",
      { survivorId: survivor.id, mergedId: merged.id },
      context(member),
    );
    expect((await values("deals.deal", deal.id)).organisation).toBe(survivor.id);
  });

  it("deal participants, and any extension relation to people, follow a merged person", async () => {
    const survivor = await invoke("person.create", { displayName: unique("P ") }, context(member));
    const merged = await invoke("person.create", { displayName: unique("P ") }, context(member));
    const bystander = await invoke("person.create", { displayName: unique("B ") }, context(member));
    const deal = await invoke(
      "record.create",
      { object: "deals.deal", values: { name: unique("Deal ") } },
      context(member),
    );
    const participant = await invoke(
      "record.create",
      {
        object: "deals.participant",
        values: { role: "champion", deal: deal.id, person: merged.id },
      },
      context(member),
    );
    const ticket = await invoke(
      "record.create",
      {
        object: `${ext}.ticket`,
        values: {
          summary: "Broken",
          contact: merged.id,
          watchers: [bystander.id, merged.id, survivor.id],
        },
      },
      context(member),
    );
    await invoke("person.merge", { survivorId: survivor.id, mergedId: merged.id }, context(member));

    expect((await values("deals.participant", participant.id)).person).toBe(survivor.id);
    const t = await values(`${ext}.ticket`, ticket.id);
    expect(t.contact).toBe(survivor.id);
    // The merged id becomes the survivor's, once, keeping the order.
    expect(t.watchers).toEqual([bystander.id, survivor.id]);
  });
});
