// Record fixtures for tests that need people and organisations without going through
// organisation.* operations (built in a parallel branch).
import { env } from "cloudflare:workers";
import { type ActingUser, invoke, newId } from "../src/index.ts";
import { context, unique } from "./helpers.ts";

export async function createPerson(user: ActingUser, name = unique("Person")) {
  return invoke(
    "person.create",
    { displayName: name, emails: [{ email: `${unique("p")}@example.com` }] },
    context(user),
  );
}

/** Inserts a live organisation (and its domains) directly. */
export async function insertOrganisation(name = unique("Org"), domains: string[] = []) {
  const id = newId("organisation");
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_organisation (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, name, now, now)
    .run();
  for (const [position, domain] of domains.entries()) {
    await env.DB.prepare(
      "INSERT INTO core_organisation_domains (id, organisation_id, domain, is_primary, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(newId("domain"), id, domain, position === 0 ? 1 : 0, position, now)
      .run();
  }
  return { id, name };
}
