// Record fixtures for tests, built through the real operations so they carry the same rows,
// audit and search entries a user's records would.
import { type ActingUser, invoke } from "../src/index.ts";
import { context, createUser, unique } from "./helpers.ts";

let fixtureUser: Promise<ActingUser> | undefined;
/** A member that owns fixture records when a test doesn't care who made them. */
const author = () => {
  fixtureUser ??= createUser("member");
  return fixtureUser;
};

export async function createPerson(user: ActingUser, name = unique("Person")) {
  return invoke(
    "person.create",
    { displayName: name, emails: [{ email: `${unique("p")}@example.com` }] },
    context(user),
  );
}

/** A live organisation (with its domains, the first primary), via organisation.create. */
export async function insertOrganisation(name = unique("Org"), domains: string[] = []) {
  const org = await invoke(
    "organisation.create",
    { name, domains: domains.map((domain) => ({ domain })) },
    context(await author()),
  );
  return { id: org.id, name: org.name };
}

type Links = [object: string, id: string][];
const refs = (links: Links) => links.map(([object, id]) => ({ object, id }));

/** A note linked to `links`, via activity.log. Returns its id. */
export async function insertActivity(
  subject: string,
  links: Links,
  { body = "notes", user }: { body?: string; user?: ActingUser } = {},
): Promise<string> {
  const activity = await invoke(
    "activity.log",
    { type: "note", subject, body, links: refs(links) },
    context(user ?? (await author())),
  );
  return activity.id;
}

/** An open task linked to `links`, via task.create. Returns its id. */
export async function insertTask(
  title: string,
  links: Links,
  { user }: { user?: ActingUser } = {},
): Promise<string> {
  const task = await invoke(
    "task.create",
    { title, links: refs(links) },
    context(user ?? (await author())),
  );
  return task.id;
}
