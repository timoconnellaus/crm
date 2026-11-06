// The hosted plugin marketplace (ADR 0347): listings a workspace can search and install, and the
// review queue behind them. Every call is authenticated: a hosted deployment signs it (ADR 0250),
// a self-hosted one sends the workspace token staff issued it. Only reviewed listings are ever
// returned. What is stored here is what a workspace submitted for publication, nothing else.
import {
  compareVersions,
  listingOf,
  MARKETPLACE_LISTINGS_PATH,
  MARKETPLACE_SUBMISSIONS_PATH,
  manifestFingerprint,
  marketplaceSubmissionSchema,
  type PluginManifest,
  pluginIdSchema,
  pluginManifestSchema,
} from "@relationship-os/agent-plugins";
import { verifyDeploymentRequest } from "@relationship-os/release";
import { audit } from "./audit.ts";
import { instanceById } from "./db.ts";
import { tenantChannelKey } from "./platform-ai.ts";
import type { Services } from "./services.ts";
import { newId, randomToken, safeEqual, sha256Hex } from "./util.ts";

const MAX_BODY_BYTES = 1_048_576;
const MAX_RESULTS = 100;
const MAX_QUERY_LENGTH = 100;
const REVIEW_PAGE_SIZE = 25;

export interface ListingRow {
  plugin_id: string;
  version: string;
  name: string;
  publisher: string;
  description: string;
  listing: string;
  owner: string;
  installs: number;
  delisted: number;
  updated_at: string;
}

export interface SubmissionRow {
  id: string;
  plugin_id: string;
  version: string;
  manifest: string;
  note: string | null;
  submitted_by: string;
  status: "in_review" | "approved" | "rejected";
  reason: string | null;
  reviewed_by: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface TokenRow {
  id: string;
  token_hash: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

/** Who is calling: `submitter` is what cp_marketplace_submissions and listings record. */
interface Caller {
  submitter: string;
  accountId: string | null;
  instanceId: string | null;
}

const refuse = (status: number, error: string) => Response.json({ ok: false, error }, { status });

/** The request body as text, or null when it is over the cap (with or without a content-length). */
async function cappedText(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function signedCaller(s: Services, request: Request): Promise<Caller | null> {
  const verified = await verifyDeploymentRequest(
    request,
    async (tenant) => {
      const instance = await instanceById(s.db, tenant);
      // A suspended or deleted workspace has no standing here, whatever key it still holds.
      return instance && ["active", "paused"].includes(instance.status)
        ? tenantChannelKey(s, tenant)
        : null;
    },
    { now: s.now() },
  );
  if (!verified.ok) return null;
  const instance = await instanceById(s.db, verified.tenant);
  return {
    submitter: `tenant:${verified.tenant}`,
    accountId: instance?.account_id ?? null,
    instanceId: verified.tenant,
  };
}

async function tokenCaller(s: Services, header: string): Promise<Caller | null> {
  const token = /^Bearer (\S{1,200})$/.exec(header)?.[1];
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await s.db
    .prepare("SELECT * FROM cp_marketplace_tokens WHERE token_hash = ?")
    .bind(hash)
    .first<TokenRow>();
  if (!row || row.revoked_at || !safeEqual(row.token_hash, hash)) return null;
  return { submitter: `token:${row.id}`, accountId: null, instanceId: null };
}

/** A signed request stands or falls on its signature: a bad one never falls back to a token. */
async function authenticate(s: Services, request: Request, body: string): Promise<Caller | null> {
  if (request.headers.has("x-ros-signature")) {
    // cappedText consumed the body, and the signature covers it.
    const { url, method, headers } = request;
    return signedCaller(
      s,
      method === "POST" ? new Request(url, { method, headers, body }) : request,
    );
  }
  const header = request.headers.get("authorization");
  return header ? tokenCaller(s, header) : null;
}

/** Whether a request is for the marketplace API, so app.ts can route it before its form checks. */
export function isMarketplacePath(path: string): boolean {
  return [MARKETPLACE_LISTINGS_PATH, MARKETPLACE_SUBMISSIONS_PATH].some(
    (base) => path === base || path.startsWith(`${base}/`),
  );
}

export async function handleMarketplace(s: Services, request: Request): Promise<Response> {
  const body = request.method === "POST" ? await cappedText(request) : "";
  if (body === null) return refuse(413, "the request is too large");
  const caller = await authenticate(s, request, body);
  if (!caller) return refuse(401, "sign the request or send a workspace token");

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === MARKETPLACE_LISTINGS_PATH) {
    return method === "GET"
      ? search(s, url.searchParams.get("q") ?? "")
      : refuse(405, "method not allowed");
  }
  if (path === MARKETPLACE_SUBMISSIONS_PATH) {
    return method === "POST" ? submit(s, caller, body) : refuse(405, "method not allowed");
  }
  if (method !== "GET") return refuse(405, "method not allowed");
  const id = path.slice(path.lastIndexOf("/") + 1);
  return path === `${MARKETPLACE_LISTINGS_PATH}/${id}`
    ? getListing(s, id)
    : getSubmission(s, caller, id);
}

function listingOut(row: ListingRow) {
  return { ...JSON.parse(row.listing), installs: row.installs, updatedAt: row.updated_at };
}

async function search(s: Services, query: string): Promise<Response> {
  const q = query.trim().slice(0, MAX_QUERY_LENGTH);
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const { results } = await s.db
    .prepare(
      `SELECT * FROM cp_marketplace_listings
       WHERE delisted = 0
         AND (name LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\' OR publisher LIKE ?1 ESCAPE '\\')
       ORDER BY installs DESC, name LIMIT ?2`,
    )
    .bind(like, MAX_RESULTS)
    .all<ListingRow>();
  return Response.json({ listings: results.map(listingOut) });
}

async function getListing(s: Services, pluginId: string): Promise<Response> {
  if (!pluginIdSchema.safeParse(pluginId).success) return refuse(404, "no such plugin");
  const row = await s.db
    .prepare(
      `SELECT l.*, v.manifest FROM cp_marketplace_listings l
       JOIN cp_marketplace_versions v ON v.plugin_id = l.plugin_id AND v.version = l.version
       WHERE l.plugin_id = ? AND l.delisted = 0`,
    )
    .bind(pluginId)
    .first<ListingRow & { manifest: string }>();
  if (!row) return refuse(404, "no such plugin");
  return Response.json({ listing: listingOut(row), manifest: JSON.parse(row.manifest) });
}

const submissionOut = (row: Pick<SubmissionRow, "id" | "status" | "reason">) => ({
  id: row.id,
  status: row.status,
  reason: row.reason,
});

async function submit(s: Services, caller: Caller, body: string): Promise<Response> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return refuse(400, "expected JSON");
  }
  const parsed = marketplaceSubmissionSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return refuse(400, `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const { manifest, note } = parsed.data;
  const listed = await s.db
    .prepare("SELECT version, owner FROM cp_marketplace_listings WHERE plugin_id = ?")
    .bind(manifest.id)
    .first<Pick<ListingRow, "version" | "owner">>();
  if (listed && listed.owner !== caller.submitter) {
    return refuse(403, "that plugin id belongs to another publisher");
  }
  if (listed && compareVersions(manifest.version, listed.version) <= 0) {
    return refuse(409, `the version must be newer than ${listed.version}`);
  }

  const id = newId("sub");
  const stored = JSON.stringify(manifest);
  const now = s.now();
  const inserted = await s.db
    .prepare(
      `INSERT INTO cp_marketplace_submissions
         (id, plugin_id, version, manifest, note, submitted_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'in_review', ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      id,
      manifest.id,
      manifest.version,
      stored,
      note || null,
      caller.submitter,
      now.toISOString(),
    )
    .run();
  if (!inserted.meta.changes) {
    // This submitter already has this version in review. The same manifest again is a replay.
    const open = await s.db
      .prepare(
        "SELECT * FROM cp_marketplace_submissions WHERE plugin_id = ? AND version = ? AND submitted_by = ? AND status = 'in_review'",
      )
      .bind(manifest.id, manifest.version, caller.submitter)
      .first<SubmissionRow>();
    if (open?.manifest === stored) return Response.json(submissionOut(open));
    return refuse(409, "that version is already in review with different contents");
  }
  await audit(
    s.db,
    {
      actorKind: "customer",
      actor: caller.submitter,
      action: "marketplace.submitted",
      accountId: caller.accountId,
      instanceId: caller.instanceId,
      detail: { submission: id, plugin: manifest.id, version: manifest.version },
    },
    now,
  );
  return Response.json({ id, status: "in_review", reason: null }, { status: 201 });
}

async function getSubmission(s: Services, caller: Caller, id: string): Promise<Response> {
  const row = await s.db
    .prepare("SELECT * FROM cp_marketplace_submissions WHERE id = ?")
    .bind(id)
    .first<SubmissionRow>();
  // Someone else's submission looks the same as none at all.
  if (!row || row.submitted_by !== caller.submitter) return refuse(404, "no such submission");
  return Response.json(submissionOut(row));
}

// ---- Review (the admin console) -----------------------------------------------------------------

export interface QueueEntry {
  submission: SubmissionRow;
  manifest: PluginManifest;
  listed: Pick<ListingRow, "version" | "owner" | "delisted"> | null;
}

type QueueRow = SubmissionRow & {
  listed_version: string | null;
  listed_owner: string;
  listed_delisted: number;
};

export async function reviewPageData(s: Services) {
  const { results: queue } = await s.db
    .prepare(
      `SELECT s.*, l.version AS listed_version, l.owner AS listed_owner, l.delisted AS listed_delisted
       FROM cp_marketplace_submissions s
       LEFT JOIN cp_marketplace_listings l ON l.plugin_id = s.plugin_id
       WHERE s.status = 'in_review' ORDER BY s.created_at LIMIT ?`,
    )
    .bind(REVIEW_PAGE_SIZE)
    .all<QueueRow>();
  const open = await s.db
    .prepare("SELECT COUNT(*) AS n FROM cp_marketplace_submissions WHERE status = 'in_review'")
    .first<{ n: number }>();
  const { results: listings } = await s.db
    .prepare("SELECT * FROM cp_marketplace_listings ORDER BY name LIMIT 500")
    .all<ListingRow>();
  const { results: tokens } = await s.db
    .prepare("SELECT * FROM cp_marketplace_tokens ORDER BY created_at DESC LIMIT 500")
    .all<TokenRow>();
  return {
    open: open?.n ?? 0,
    queue: queue.map(
      (row): QueueEntry => ({
        submission: row,
        manifest: pluginManifestSchema.parse(JSON.parse(row.manifest)),
        listed: row.listed_version
          ? { version: row.listed_version, owner: row.listed_owner, delisted: row.listed_delisted }
          : null,
      }),
    ),
    listings,
    tokens,
  };
}

/** Publishes a submission. Returns why it could not, or null when it is live. */
export async function approveSubmission(
  s: Services,
  id: string,
  staff: string,
): Promise<string | null> {
  const row = await s.db
    .prepare("SELECT * FROM cp_marketplace_submissions WHERE id = ?")
    .bind(id)
    .first<SubmissionRow>();
  if (row?.status !== "in_review") return "That submission is not in review.";
  const manifest = pluginManifestSchema.parse(JSON.parse(row.manifest));
  // The checks made at submission can have gone stale while this waited in the queue.
  const listed = await s.db
    .prepare("SELECT version, owner FROM cp_marketplace_listings WHERE plugin_id = ?")
    .bind(manifest.id)
    .first<Pick<ListingRow, "version" | "owner">>();
  if (listed && listed.owner !== row.submitted_by) {
    return `${manifest.id} is listed by another publisher. Reject this one.`;
  }
  if (listed && compareVersions(manifest.version, listed.version) <= 0) {
    return `${manifest.id} is already listed at ${listed.version}. Reject this one.`;
  }

  const now = s.now();
  const iso = now.toISOString();
  const fingerprint = await manifestFingerprint(manifest);
  // One transaction. Each statement repeats the guard, so if another approval won the race nothing
  // here is written: the listing moves only from the version read above, and the rest follow it.
  const published =
    "EXISTS (SELECT 1 FROM cp_marketplace_listings WHERE plugin_id = ? AND version = ? AND owner = ?)";
  const guard = [manifest.id, manifest.version, row.submitted_by];
  const results = await s.db.batch([
    s.db
      .prepare(
        `INSERT INTO cp_marketplace_listings
           (plugin_id, version, name, publisher, description, listing, owner, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (plugin_id) DO UPDATE SET
           version = excluded.version, name = excluded.name, publisher = excluded.publisher,
           description = excluded.description, listing = excluded.listing, delisted = 0,
           updated_at = excluded.updated_at
         WHERE cp_marketplace_listings.version IS ?9 AND cp_marketplace_listings.owner = ?7`,
      )
      .bind(
        manifest.id,
        manifest.version,
        manifest.name,
        manifest.publisher,
        manifest.description,
        JSON.stringify(listingOf(manifest)),
        row.submitted_by,
        iso,
        listed?.version ?? null,
      ),
    s.db
      .prepare(
        `INSERT OR IGNORE INTO cp_marketplace_versions (plugin_id, version, manifest, fingerprint)
         SELECT ?, ?, ?, ? WHERE ${published}`,
      )
      .bind(manifest.id, manifest.version, row.manifest, fingerprint, ...guard),
    s.db
      .prepare(
        `UPDATE cp_marketplace_submissions SET status = 'approved', reviewed_by = ?, reviewed_at = ?
         WHERE id = ? AND status = 'in_review' AND ${published}`,
      )
      .bind(staff, iso, id, ...guard),
  ]);
  if (!results[2]?.meta.changes) return "Someone else reviewed this first. Check the queue.";
  await audit(
    s.db,
    {
      actorKind: "staff",
      actor: staff,
      action: "marketplace.approved",
      detail: { submission: id, plugin: manifest.id, version: manifest.version, fingerprint },
    },
    now,
  );
  return null;
}

/** Returns why it could not be rejected, or null. */
export async function rejectSubmission(
  s: Services,
  id: string,
  staff: string,
  reason: string,
): Promise<string | null> {
  if (!reason) return "Give the submitter a reason.";
  const now = s.now();
  const row = await s.db
    .prepare(
      `UPDATE cp_marketplace_submissions SET status = 'rejected', reason = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ? AND status = 'in_review' RETURNING plugin_id, version`,
    )
    .bind(reason.slice(0, 1_000), staff, now.toISOString(), id)
    .first<Pick<SubmissionRow, "plugin_id" | "version">>();
  if (!row) return "That submission is not in review.";
  await audit(
    s.db,
    {
      actorKind: "staff",
      actor: staff,
      action: "marketplace.rejected",
      detail: { submission: id, plugin: row.plugin_id, version: row.version, reason },
    },
    now,
  );
  return null;
}

/** Hides a listing; its next approved version lists it again. False if it was not listed. */
export async function delistPlugin(s: Services, pluginId: string, staff: string): Promise<boolean> {
  const row = await s.db
    .prepare(
      "UPDATE cp_marketplace_listings SET delisted = 1 WHERE plugin_id = ? AND delisted = 0 RETURNING version",
    )
    .bind(pluginId)
    .first<Pick<ListingRow, "version">>();
  if (!row) return false;
  await audit(
    s.db,
    {
      actorKind: "staff",
      actor: staff,
      action: "marketplace.delisted",
      detail: { plugin: pluginId, version: row.version },
    },
    s.now(),
  );
  return true;
}

/** Issues a workspace token. The caller shows it once: only its hash is kept. */
export async function issueToken(s: Services, label: string, staff: string): Promise<string> {
  const id = newId("mkt");
  const token = `ros_mkt_${randomToken()}`;
  const now = s.now();
  await s.db
    .prepare(
      "INSERT INTO cp_marketplace_tokens (id, token_hash, label, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(id, await sha256Hex(token), label, now.toISOString())
    .run();
  await audit(
    s.db,
    {
      actorKind: "staff",
      actor: staff,
      action: "marketplace.token_issued",
      detail: { token: id, label },
    },
    now,
  );
  return token;
}

/** False if the token is unknown or already revoked. */
export async function revokeToken(s: Services, id: string, staff: string): Promise<boolean> {
  const now = s.now();
  const row = await s.db
    .prepare(
      "UPDATE cp_marketplace_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING label",
    )
    .bind(now.toISOString(), id)
    .first<Pick<TokenRow, "label">>();
  if (!row) return false;
  await audit(
    s.db,
    {
      actorKind: "staff",
      actor: staff,
      action: "marketplace.token_revoked",
      detail: { token: id, label: row.label },
    },
    now,
  );
  return true;
}
