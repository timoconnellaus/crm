// The simulation overlay (ADR 0022). A session's pending actions record, at queue time, how each
// record they touch would look once applied (`simulated.records`). Reads by that session (`get`,
// `list`, `search.global`, `activity.listForRecord`) see those records as if applied; everyone
// else reads real data. Creates appear under provisional ids (`per_pending_…`).
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { NotFoundError } from "../errors.ts";
import { isProvisionalId } from "../ids.ts";
import type { SimulatedRecord, SimulationView } from "../operation.ts";
import { loadActivity } from "../operations/activity.ts";
import { loadOrganisation } from "../operations/organisation.ts";
import { loadPerson } from "../operations/person.ts";
import { highlight, searchTerms } from "../operations/search.ts";
import { loadTask } from "../operations/task.ts";
import { loadRecordTitles } from "../records/links.ts";

type Rec = Record<string, unknown>;

/** Per-object knowledge the overlay needs: how to load, build, list and search a record. */
interface ObjectSim {
  load(db: Kysely<CoreDatabase>, id: string): Promise<Rec | null>;
  /** The `<object>.list` item shape (person and organisation lists flatten some fields). */
  listItem(record: Rec): Rec;
  /** Search hit title and subtitle. */
  display(record: Rec): { title: string; subtitle: string | null };
  /** The text search matches against. */
  searchText(record: Rec): string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const primary = (list: Rec[], key: string): string | null =>
  str((list.find((x) => x.primary) ?? list[0])?.[key]);

export const SIMULATED_OBJECTS: Record<string, ObjectSim> = {
  person: {
    load: (db, id) => loadPerson(db, id, { includeDeleted: true }) as Promise<Rec | null>,
    listItem: (r) => {
      const aff = (r.primaryAffiliation ?? null) as Rec | null;
      return {
        ...r,
        primaryEmail: primary(arr(r.emails), "email"),
        emails: arr(r.emails).map((e) => e.email),
        primaryPhone: primary(arr(r.phones), "number"),
        organisationId: aff?.organisationId ?? null,
        organisationName: aff?.organisationName ?? null,
      };
    },
    display: (r) => ({
      title: String(r.displayName ?? ""),
      subtitle:
        [str(r.jobTitle), primary(arr(r.emails), "email")].filter(Boolean).join(" · ") || null,
    }),
    searchText: (r) =>
      [r.displayName, r.givenName, r.familyName, ...arr(r.emails).map((e) => e.email)]
        .filter(Boolean)
        .join(" "),
  },
  organisation: {
    load: (db, id) => loadOrganisation(db, id, { includeDeleted: true }) as Promise<Rec | null>,
    listItem: (r) => ({
      ...r,
      primaryDomain: primary(arr(r.domains), "domain"),
      domains: arr(r.domains).map((d) => d.domain),
    }),
    display: (r) => ({
      title: String(r.name ?? ""),
      subtitle:
        [primary(arr(r.domains), "domain"), str(r.industry)].filter(Boolean).join(" · ") || null,
    }),
    searchText: (r) => [r.name, ...arr(r.domains).map((d) => d.domain)].filter(Boolean).join(" "),
  },
  task: {
    load: (db, id) => loadTask(db, id, { includeDeleted: true }) as Promise<Rec | null>,
    listItem: (r) => r,
    display: (r) => ({
      title: String(r.title ?? ""),
      subtitle:
        r.status === "done"
          ? "Task · done"
          : r.dueAt
            ? `Task · due ${String(r.dueAt).slice(0, 10)}`
            : "Task",
    }),
    searchText: (r) => [r.title, r.notes].filter(Boolean).join(" "),
  },
  activity: {
    load: (db, id) => loadActivity(db, id, { includeDeleted: true }) as Promise<Rec | null>,
    listItem: (r) => r,
    display: (r) => {
      const type = String(r.type ?? "activity");
      const label = type.charAt(0).toUpperCase() + type.slice(1);
      return {
        title: str(r.subject) ?? String(r.body ?? "").slice(0, 80) ?? label,
        subtitle: `${label} · ${String(r.occurredAt ?? "").slice(0, 10)}`,
      };
    },
    searchText: (r) => [r.subject, r.body].filter(Boolean).join(" "),
  },
};

/** The display title of any simulated record, for link titles. */
export function simulatedTitle(record: SimulatedRecord): string | null {
  const sim = SIMULATED_OBJECTS[record.object];
  return sim && record.record ? sim.display(record.record).title : null;
}

interface StoredRecord {
  object: string;
  id: string;
  state: "live" | "deleted";
  record: Rec | null;
}

/** A session's pending actions, in queue order, as a SimulationView. */
export class Overlay implements SimulationView {
  readonly #byKey = new Map<string, SimulatedRecord>();
  constructor(readonly actionIds: readonly string[] = []) {}

  add(actionId: string, changeSetId: string, records: readonly StoredRecord[]): void {
    for (const r of records) {
      this.#byKey.set(`${r.object}:${r.id}`, { ...r, actionId, changeSetId });
    }
  }

  get empty(): boolean {
    return this.#byKey.size === 0;
  }

  record(object: string, id: string): SimulatedRecord | undefined {
    return this.#byKey.get(`${object}:${id}`);
  }

  records(): SimulatedRecord[] {
    return [...this.#byKey.values()];
  }
}

/** Loads the overlay for `sessionId`: its pending, unexpired actions in queue order. */
export async function loadSessionOverlay(
  db: Kysely<CoreDatabase>,
  sessionId: string | undefined,
  now: string,
): Promise<Overlay> {
  if (!sessionId) return new Overlay();
  const rows = await db
    .selectFrom("core_pending_action as p")
    .innerJoin("core_change_set as c", "c.id", "p.change_set_id")
    .select(["p.id", "p.change_set_id", "p.simulated"])
    .where("c.session_id", "=", sessionId)
    .where("p.status", "=", "pending")
    .where("p.expires_at", ">", now)
    .orderBy("p.id")
    .execute();
  const overlay = new Overlay(rows.map((r) => r.id));
  for (const row of rows) {
    const simulated = JSON.parse(row.simulated) as { records?: StoredRecord[] };
    overlay.add(row.id, row.change_set_id, simulated.records ?? []);
  }
  return overlay;
}

function pendingMarker(sim: SimulatedRecord) {
  return {
    status: "pending_approval",
    actionId: sim.actionId,
    changeSetId: sim.changeSetId,
    provisional: isProvisionalId(sim.id),
  };
}

const GET_OPS = new Set(["person.get", "organisation.get", "task.get", "activity.get"]);
const LIST_OPS = new Set(["person.list", "organisation.list", "task.list", "activity.list"]);

/** True when `operation` is a read the overlay changes. */
export function isSimulatedRead(operation: string): boolean {
  return (
    GET_OPS.has(operation) ||
    LIST_OPS.has(operation) ||
    operation === "search.global" ||
    operation === "activity.listForRecord"
  );
}

/**
 * Applies the overlay to one read. `real` runs the operation against real data (and validates
 * its output); it is skipped when the answer is wholly simulated (a provisional id).
 */
export async function overlayRead(
  operation: string,
  input: Rec,
  overlay: Overlay,
  real: () => Promise<unknown>,
): Promise<unknown> {
  const object = operation.split(".")[0] ?? "";

  if (GET_OPS.has(operation)) {
    const id = String(input.id);
    const sim = overlay.record(object, id);
    if (!sim) {
      if (isProvisionalId(id)) throw new NotFoundError(object, id);
      return real();
    }
    if (sim.state === "deleted" && !input.includeDeleted) throw new NotFoundError(object, id);
    if (!sim.record) return real();
    return { ...sim.record, pending: pendingMarker(sim) };
  }

  if (LIST_OPS.has(operation)) {
    const page = (await real()) as { items: Rec[]; nextCursor: string | null };
    const fields = Array.isArray(input.fields) ? (input.fields as string[]) : null;
    const items = patchItems(object, page.items, overlay);
    const additions =
      input.cursor || input.filter
        ? []
        : overlay
            .records()
            .filter((r) => r.object === object && r.state === "live" && r.record)
            .filter((r) => isProvisionalId(r.id))
            .map((r) => {
              const item = SIMULATED_OBJECTS[object]?.listItem(r.record as Rec) ?? {};
              const picked = fields
                ? Object.fromEntries(
                    Object.entries(item).filter(([k]) => k === "id" || fields.includes(k)),
                  )
                : item;
              return { ...picked, pending: pendingMarker(r) };
            });
    return { ...page, items: [...additions, ...items] };
  }

  if (operation === "search.global") {
    const out = (await real()) as { hits: Rec[] };
    const terms = searchTerms(String(input.query ?? ""));
    const objects = Array.isArray(input.objects) ? (input.objects as string[]) : null;
    const seen = new Set<string>();
    const hits: Rec[] = [];
    for (const hit of out.hits) {
      const key = `${hit.object}:${hit.id}`;
      seen.add(key);
      const sim = overlay.record(String(hit.object), String(hit.id));
      if (!sim) {
        hits.push(hit);
        continue;
      }
      if (sim.state === "deleted") continue;
      const objectSim = SIMULATED_OBJECTS[sim.object];
      if (!sim.record || !objectSim) {
        hits.push(hit);
        continue;
      }
      const display = objectSim.display(sim.record);
      hits.push({
        ...hit,
        ...display,
        titleHighlight: highlight(display.title, terms),
        pending: pendingMarker(sim),
      });
    }
    const added: Rec[] = [];
    if (terms.length) {
      for (const sim of overlay.records()) {
        const objectSim = SIMULATED_OBJECTS[sim.object];
        if (!objectSim || sim.state !== "live" || !sim.record) continue;
        if (seen.has(`${sim.object}:${sim.id}`)) continue;
        if (objects && !objects.includes(sim.object)) continue;
        if (!matchesTerms(objectSim.searchText(sim.record), terms)) continue;
        const display = objectSim.display(sim.record);
        added.push({
          object: sim.object,
          id: sim.id,
          ...display,
          titleHighlight: highlight(display.title, terms),
          snippet: null,
          pending: pendingMarker(sim),
        });
      }
    }
    const limit = typeof input.limit === "number" ? input.limit : 20;
    return { ...out, hits: [...added, ...hits].slice(0, limit) };
  }

  if (operation === "activity.listForRecord") {
    const recordObject = String(input.object);
    const recordId = String(input.recordId);
    const page = isProvisionalId(recordId)
      ? { items: [] as Rec[], nextCursor: null }
      : ((await real()) as { items: Rec[]; nextCursor: string | null });
    const items = patchItems("activity", page.items, overlay);
    if (input.cursor) return { ...page, items };
    const present = new Set(items.map((i) => String(i.id)));
    const types = Array.isArray(input.types) ? (input.types as string[]) : null;
    const added = overlay
      .records()
      .filter((r) => r.object === "activity" && r.state === "live" && r.record)
      .filter((r) => !present.has(r.id))
      .filter((r) => !types || types.includes(String(r.record?.type)))
      .filter((r) =>
        arr(r.record?.links).some((l) => l.object === recordObject && l.id === recordId),
      )
      .map((r): Rec => ({ ...(r.record as Rec), pending: pendingMarker(r) }));
    const merged = [...added, ...items].sort((a, b) =>
      String(b.occurredAt ?? "").localeCompare(String(a.occurredAt ?? "")),
    );
    return { ...page, items: merged };
  }

  return real();
}

function patchItems(object: string, items: Rec[], overlay: Overlay): Rec[] {
  const out: Rec[] = [];
  for (const item of items) {
    const sim = overlay.record(object, String(item.id));
    if (!sim) {
      out.push(item);
      continue;
    }
    if (sim.state === "deleted") continue;
    const full = sim.record ? (SIMULATED_OBJECTS[object]?.listItem(sim.record) ?? sim.record) : {};
    const patched: Rec = { ...item };
    for (const key of Object.keys(item)) if (key in full) patched[key] = full[key];
    out.push({ ...patched, pending: pendingMarker(sim) });
  }
  return out;
}

function matchesTerms(text: string, terms: readonly string[]): boolean {
  const words =
    text
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.every((term) => words.some((w) => w.startsWith(term)));
}

/** Link titles for refs, from the overlay for provisional or pending records, else the DB. */
export async function titlesFor(
  db: Kysely<CoreDatabase>,
  refs: readonly { object: string; id: string }[],
  overlay: SimulationView | undefined,
): Promise<Map<string, string>> {
  const titles = await loadRecordTitles(
    db,
    refs.filter((r) => !isProvisionalId(r.id)),
  );
  for (const ref of refs) {
    const sim = overlay?.record(ref.object, ref.id);
    const title = sim ? simulatedTitle(sim) : null;
    if (title) titles.set(`${ref.object}:${ref.id}`, title);
  }
  return titles;
}
