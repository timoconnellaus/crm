// End to end across the two stage-1 operation slices: organisations arrive by CSV import
// (import.csv.*), a person changes job between them (person.changeJob), a meeting is logged on all
// three (activity.log), the organisations are merged (organisation.merge), and the timelines,
// search and History tab (activity.listForRecord, search.global, audit.listForRecord) agree.
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke } from "../src/index.ts";
import { context, createUser, unique } from "./helpers.ts";

let member: ActingUser;
const ctx = () => context(member);

beforeAll(async () => {
  member = await createUser("member");
});

describe("import → changeJob → meeting → organisation.merge", () => {
  it("keeps timelines, search and history consistent", async () => {
    const tag = unique("xf").toLowerCase();
    const oldName = `Oldco ${tag}`;
    const newName = `Newco ${tag}`;
    const oldDomain = `${tag}-old.example`;
    const newDomain = `${tag}-new.example`;

    // 1. Import two organisations.
    const csv = [
      "Company,Domain,Industry",
      `${oldName},https://www.${oldDomain}/about,Retail`,
      `${newName},${newDomain},Software`,
    ].join("\n");
    const imported = await invoke("import.csv.commit", { object: "organisation", csv }, ctx());
    expect(imported.counts).toMatchObject({ create: 2, skip: 0 });
    const [oldId, newId] = imported.rows.map((r) => r.id as string);
    if (!oldId || !newId) throw new Error("import did not create both organisations");

    // Imported organisations record the same audit snapshot shape as organisation.create.
    const [importCreate] = (
      await invoke("audit.listForRecord", { object: "organisation", recordId: oldId }, ctx())
    ).items;
    expect(importCreate).toMatchObject({ operation: "import.csv.commit", action: "create" });
    expect(importCreate?.diff.domains).toEqual({
      before: null,
      after: [{ domain: oldDomain, primary: true }],
    });
    const direct = await invoke(
      "organisation.create",
      {
        name: unique("Direct"),
        industry: "Retail",
        domains: [{ domain: `${tag}-direct.example` }],
      },
      ctx(),
    );
    const [directCreate] = (
      await invoke("audit.listForRecord", { object: "organisation", recordId: direct.id }, ctx())
    ).items;
    expect(Object.keys(importCreate?.diff ?? {}).sort()).toEqual(
      Object.keys(directCreate?.diff ?? {}).sort(),
    );

    // 2. A person works at the old organisation, then changes job to the new one.
    const person = await invoke(
      "person.create",
      { displayName: `Ada ${tag}`, emails: [{ email: `${tag}@example.com` }] },
      ctx(),
    );
    await invoke("affiliation.create", { personId: person.id, organisationId: oldId }, ctx());
    const job = await invoke(
      "person.changeJob",
      { personId: person.id, organisationId: newId, title: "CTO" },
      ctx(),
    );

    // 3. A meeting with the person and both organisations.
    const meeting = await invoke(
      "activity.log",
      {
        type: "meeting",
        subject: `Kick-off ${tag}`,
        body: "Agreed the plan",
        links: [
          { object: "person", id: person.id },
          { object: "organisation", id: oldId },
          { object: "organisation", id: newId },
        ],
      },
      ctx(),
    );

    // 4. The old organisation turns out to be a duplicate.
    const merged = await invoke(
      "organisation.merge",
      { survivorId: newId, mergedId: oldId },
      ctx(),
    );
    expect(merged.domains.map((d) => d.domain)).toEqual([newDomain, oldDomain]);
    expect(merged.moved.activities).toBeGreaterThanOrEqual(1);

    // Timelines: the survivor shows the meeting once, plus the job change and the merge.
    const survivorTimeline = (
      await invoke("activity.listForRecord", { object: "organisation", recordId: newId }, ctx())
    ).items;
    expect(survivorTimeline.filter((a) => a.id === meeting.id)).toHaveLength(1);
    const kinds = survivorTimeline.map((a) => a.payload.kind).filter(Boolean);
    expect(kinds).toEqual(expect.arrayContaining(["merge", "job_change"]));
    expect(survivorTimeline.some((a) => a.id === job.activityId)).toBe(true);
    const meetingNow = survivorTimeline.find((a) => a.id === meeting.id);
    expect(meetingNow?.links.map((l) => l.id).sort()).toEqual([newId, person.id].sort());

    const personTimeline = (
      await invoke("activity.listForRecord", { object: "person", recordId: person.id }, ctx())
    ).items;
    expect(personTimeline.map((a) => a.id)).toEqual(
      expect.arrayContaining([meeting.id, job.activityId]),
    );
    // The merged-away organisation's timeline keeps only the merge notice.
    const oldTimeline = (
      await invoke("activity.listForRecord", { object: "organisation", recordId: oldId }, ctx())
    ).items;
    expect(oldTimeline.map((a) => a.payload.kind)).toEqual(["merge"]);

    // Affiliations moved: the person's history now points at the survivor only.
    const affiliations = await invoke("affiliation.list", { personId: person.id }, ctx());
    expect(new Set(affiliations.items.map((a) => a.organisationId))).toEqual(new Set([newId]));

    // Search: the old domain and the meeting now lead to the survivor; the old name is gone.
    const byOldDomain = await invoke("search.global", { query: oldDomain }, ctx());
    expect(byOldDomain.hits.map((h) => h.id)).toEqual([newId]);
    const byOldName = await invoke(
      "search.global",
      { query: oldName, objects: ["organisation"] },
      ctx(),
    );
    expect(byOldName.hits.map((h) => h.id)).not.toContain(oldId);
    const byMeeting = await invoke(
      "search.global",
      { query: `Kick-off ${tag}`, objects: ["activity"] },
      ctx(),
    );
    expect(byMeeting.hits.map((h) => h.id)).toEqual([meeting.id]);
    const byPerson = await invoke("search.global", { query: `Ada ${tag}` }, ctx());
    expect(byPerson.hits.map((h) => h.id)).toContain(person.id);

    // History: import create, then the merge, on both records.
    const survivorHistory = (
      await invoke("audit.listForRecord", { object: "organisation", recordId: newId }, ctx())
    ).items;
    expect(survivorHistory.map((h) => [h.operation, h.action])).toEqual([
      ["organisation.merge", "merge"],
      ["import.csv.commit", "create"],
    ]);
    expect(survivorHistory[0]?.diff.domains).toEqual({
      before: [{ domain: newDomain, primary: true }],
      after: [
        { domain: newDomain, primary: true },
        { domain: oldDomain, primary: false },
      ],
    });
    expect(survivorHistory[0]?.diff.absorbedId).toEqual({ before: null, after: oldId });
    const oldHistory = (
      await invoke("audit.listForRecord", { object: "organisation", recordId: oldId }, ctx())
    ).items;
    expect(oldHistory.map((h) => [h.operation, h.action])).toEqual([
      ["organisation.merge", "merge"],
      ["import.csv.commit", "create"],
    ]);
    expect(oldHistory[0]?.diff.mergedIntoId).toEqual({ before: null, after: newId });
    const personHistory = (
      await invoke("audit.listForRecord", { object: "person", recordId: person.id }, ctx())
    ).items;
    expect(personHistory.map((h) => h.operation)).toContain("person.create");
  });
});
