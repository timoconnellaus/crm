// A fake Cloudflare REST API for tests of the CLI and the self-updater (ADR 0163). It keeps
// in-memory accounts, D1 databases (SQL runs on an injected engine), R2, KV, queues, Vectorize,
// Worker scripts with versions and deployments, secrets, schedules, assets upload sessions and
// Time Travel bookmarks. It answers `fetch(Request)`, so it can be passed to the client directly
// or served over HTTP (packages/create-crm/test).
//
// It is strict where the real API is: unknown routes 404, a Durable Object migration must carry
// the right old_tag, a version upload cannot carry migrations, and bearer tokens must match.

export interface SqlEngine {
  /** Runs SQL. Multi-statement SQL without params runs atomically. Returns one result set. */
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  /** An opaque bookmark of the current state. */
  bookmark(): Promise<string>;
  restore(bookmark: string): Promise<void>;
}

interface FakeScript {
  name: string;
  migrationTag?: string;
  versions: { id: string; metadata: Record<string, unknown>; modules: string[] }[];
  current?: string;
  secrets: Map<string, string>;
  schedules: string[];
  workersDev: boolean;
  bindings: Record<string, unknown>[];
}

export interface FakeCloudflareOptions {
  token: string;
  accountId: string;
  accountName?: string;
  subdomain?: string | null;
  zones?: { id: string; name: string }[];
  sql: () => SqlEngine;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown, info?: unknown) =>
  json(200, { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });
const fail = (status: number, code: number, message: string) =>
  json(status, { success: false, errors: [{ code, message }], messages: [], result: null });

export class FakeCloudflare {
  readonly accountId: string;
  readonly calls: { method: string; path: string }[] = [];
  readonly d1 = new Map<string, { name: string; engine: SqlEngine }>();
  readonly r2 = new Set<string>();
  readonly kv = new Map<string, string>();
  readonly queues = new Map<string, { name: string; consumers: { consumer_id: string; script_name: string; settings: unknown }[] }>();
  readonly vectorize = new Map<string, Record<string, unknown>>();
  readonly scripts = new Map<string, FakeScript>();
  readonly domains: { hostname: string; service: string; zone_id: string }[] = [];
  readonly uploadedAssets = new Set<string>();
  /** Return a Response to fail a call (failure injection), or undefined to let it through. */
  failOn: ((method: string, path: string, body: unknown) => Response | undefined) | null = null;
  subdomain: string | null;
  private readonly options: FakeCloudflareOptions;
  private counter = 0;
  private sessions = new Map<string, { pending: Set<string> }>();

  constructor(options: FakeCloudflareOptions) {
    this.options = options;
    this.accountId = options.accountId;
    this.subdomain = options.subdomain === undefined ? "example" : options.subdomain;
  }

  private id(prefix: string) {
    this.counter += 1;
    return `${prefix}-${this.counter.toString().padStart(6, "0")}`;
  }

  /** The deployed version's metadata of a script (what is live). */
  live(name: string) {
    const script = this.scripts.get(name);
    return script?.versions.find((v) => v.id === script.current);
  }

  liveBinding(script: string, binding: string) {
    const bindings = (this.live(script)?.metadata.bindings ?? []) as { name: string }[];
    return bindings.find((b) => b.name === binding) as Record<string, unknown> | undefined;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const method = request.method;
    this.calls.push({ method, path });
    const auth = request.headers.get("authorization") ?? "";
    const isAssetUpload = path.endsWith("/workers/assets/upload");
    if (!isAssetUpload && auth !== `Bearer ${this.options.token}`) {
      return fail(403, 10000, "Authentication error");
    }
    let body: unknown;
    let form: FormData | undefined;
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("application/json")) body = await request.json();
    else if (type.includes("multipart/form-data")) form = await request.formData();
    const injected = this.failOn?.(method, path, body);
    if (injected) return injected;
    try {
      return await this.route(method, path, url, body, form, auth);
    } catch (error) {
      return fail(400, 7000, (error as Error).message);
    }
  };

  private async route(
    method: string,
    path: string,
    url: URL,
    body: unknown,
    form: FormData | undefined,
    auth: string,
  ): Promise<Response> {
    const a = `/accounts/${this.accountId}`;
    const b = body as Record<string, unknown>;
    if (path === "/user/tokens/verify") return ok({ id: "tok", status: "active" });
    if (path === "/accounts") return ok([{ id: this.accountId, name: this.options.accountName ?? "Test account" }], { page: 1, total_pages: 1 });
    if (path.startsWith("/accounts/") && !path.startsWith(a)) return fail(403, 9109, "no access to account");
    if (path === "/zones") return ok(this.options.zones ?? [], { page: 1, total_pages: 1 });
    if (path === `${a}/workers/subdomain`) {
      if (method === "PUT") {
        this.subdomain = String(b.subdomain);
        return ok({ subdomain: this.subdomain });
      }
      return this.subdomain ? ok({ subdomain: this.subdomain }) : fail(404, 10007, "no subdomain");
    }

    // D1
    if (path === `${a}/d1/database`) {
      if (method === "POST") {
        const name = String(b.name);
        if ([...this.d1.values()].some((d) => d.name === name)) return fail(400, 7502, "exists");
        const uuid = this.id("d1");
        this.d1.set(uuid, { name, engine: this.options.sql() });
        return ok({ uuid, name });
      }
      return ok([...this.d1].map(([uuid, d]) => ({ uuid, name: d.name })));
    }
    let m = new RegExp(`^${a}/d1/database/([^/]+)(/.*)?$`).exec(path);
    if (m) {
      const db = this.d1.get(m[1] as string);
      if (!db) return fail(404, 7404, "database not found");
      const rest = m[2] ?? "";
      if (rest === "" && method === "DELETE") {
        this.d1.delete(m[1] as string);
        return ok(null);
      }
      if (rest === "/query") {
        const rows = await db.engine.query(String(b.sql), (b.params as unknown[]) ?? []);
        return ok([{ results: rows, success: true, meta: {} }]);
      }
      if (rest === "/time_travel/bookmark") return ok({ bookmark: await db.engine.bookmark() });
      if (rest === "/time_travel/restore") {
        const previous = await db.engine.bookmark();
        await db.engine.restore(url.searchParams.get("bookmark") ?? "");
        return ok({ bookmark: url.searchParams.get("bookmark"), previous_bookmark: previous });
      }
    }

    // R2, KV, queues, Vectorize
    if (path === `${a}/r2/buckets`) {
      if (method === "POST") {
        this.r2.add(String(b.name));
        return ok({ name: b.name });
      }
      return ok({ buckets: [...this.r2].map((name) => ({ name })) });
    }
    m = new RegExp(`^${a}/r2/buckets/([^/]+)$`).exec(path);
    if (m && method === "DELETE") {
      this.r2.delete(m[1] as string);
      return ok(null);
    }
    if (path === `${a}/storage/kv/namespaces`) {
      if (method === "POST") {
        if ([...this.kv.values()].includes(String(b.title))) return fail(400, 10014, "title exists");
        const id = this.id("kv");
        this.kv.set(id, String(b.title));
        return ok({ id, title: b.title });
      }
      return ok([...this.kv].map(([id, title]) => ({ id, title })), { page: 1, total_pages: 1 });
    }
    m = new RegExp(`^${a}/storage/kv/namespaces/([^/]+)$`).exec(path);
    if (m && method === "DELETE") {
      this.kv.delete(m[1] as string);
      return ok(null);
    }
    if (path === `${a}/queues`) {
      if (method === "POST") {
        const id = this.id("q");
        this.queues.set(id, { name: String(b.queue_name), consumers: [] });
        return ok({ queue_id: id, queue_name: b.queue_name });
      }
      return ok(
        [...this.queues].map(([queue_id, q]) => ({ queue_id, queue_name: q.name, consumers: q.consumers })),
        { page: 1, total_pages: 1 },
      );
    }
    m = new RegExp(`^${a}/queues/([^/]+)/consumers(?:/([^/]+))?$`).exec(path);
    if (m) {
      const queue = this.queues.get(m[1] as string);
      if (!queue) return fail(404, 11000, "queue not found");
      if (m[2]) {
        const consumer = queue.consumers.find((c) => c.consumer_id === m?.[2]);
        if (!consumer) return fail(404, 11000, "consumer not found");
        consumer.settings = b.settings;
        return ok(consumer);
      }
      const consumer = { consumer_id: this.id("c"), script_name: String(b.script_name), settings: b.settings };
      queue.consumers.push(consumer);
      return ok(consumer);
    }
    if (path === `${a}/vectorize/v2/indexes`) {
      if (method === "POST") {
        this.vectorize.set(String(b.name), (b.config as Record<string, unknown>) ?? {});
        return ok({ name: b.name });
      }
      return ok([...this.vectorize.keys()].map((name) => ({ name })));
    }

    // Workers
    if (path === `${a}/workers/scripts`) {
      return ok(
        [...this.scripts.values()].map((s) => ({ id: s.name, migration_tag: s.migrationTag })),
      );
    }
    if (path === `${a}/workers/domains` && method === "PUT") {
      const existing = this.domains.find((d) => d.hostname === b.hostname);
      if (existing) Object.assign(existing, b);
      else this.domains.push(b as { hostname: string; service: string; zone_id: string });
      return ok(b);
    }
    if (path === `${a}/workers/assets/upload`) {
      const jwt = auth.replace(/^Bearer /, "");
      const session = this.sessions.get(jwt);
      if (!session || !form) return fail(401, 10001, "bad upload token");
      for (const [hash] of form.entries()) {
        this.uploadedAssets.add(hash);
        session.pending.delete(hash);
      }
      if (session.pending.size === 0) {
        const done = this.id("assets-done");
        this.sessions.set(done, { pending: new Set() });
        return json(201, { success: true, errors: [], result: { jwt: done } });
      }
      return ok(null);
    }
    m = new RegExp(`^${a}/workers/scripts/([^/]+)(/.*)?$`).exec(path);
    if (m) return this.scriptRoute(method, m[1] as string, m[2] ?? "", b, form);
    return fail(404, 7003, `no route for ${method} ${path}`);
  }

  private async scriptRoute(
    method: string,
    name: string,
    rest: string,
    b: Record<string, unknown>,
    form: FormData | undefined,
  ): Promise<Response> {
    const script = this.scripts.get(name);
    if (rest === "" && method === "PUT") {
      if (!form) return fail(400, 10021, "expected multipart");
      const { metadata, modules } = await this.readUpload(form);
      const migrations = metadata.migrations as { old_tag?: string; new_tag?: string } | undefined;
      if (migrations) {
        if ((migrations.old_tag ?? undefined) !== script?.migrationTag) {
          return fail(400, 10079, `migration old_tag ${migrations.old_tag} does not match ${script?.migrationTag}`);
        }
      } else if (!script && this.needsMigration(metadata)) {
        return fail(400, 10074, "durable object classes need a migration");
      }
      const target: FakeScript =
        script ?? { name, versions: [], secrets: new Map(), schedules: [], workersDev: false, bindings: [] };
      this.applySecrets(target, metadata);
      const versionId = this.id("ver");
      target.versions.push({ id: versionId, metadata, modules });
      target.current = versionId;
      if (migrations?.new_tag) target.migrationTag = migrations.new_tag;
      this.scripts.set(name, target);
      return ok({ id: name, migration_tag: target.migrationTag });
    }
    // Works before the script exists, as for a first deploy.
    if (rest === "/assets-upload-session" && method === "POST") {
      const manifest = b.manifest as Record<string, { hash: string }>;
      const pending = new Set(
        Object.values(manifest)
          .map((f) => f.hash)
          .filter((h) => !this.uploadedAssets.has(h)),
      );
      const jwt = this.id("assets");
      this.sessions.set(jwt, { pending });
      return ok({ jwt, buckets: pending.size ? [[...pending]] : [] });
    }
    if (!script) return fail(404, 10007, `script ${name} not found`);
    if (rest === "" && method === "DELETE") {
      this.scripts.delete(name);
      return ok(null);
    }
    if (rest === "/versions" && method === "POST") {
      if (!form) return fail(400, 10021, "expected multipart");
      const { metadata, modules } = await this.readUpload(form);
      if (metadata.migrations) return fail(400, 10211, "migrations are not supported with versions");
      this.applySecrets(script, metadata);
      const id = this.id("ver");
      script.versions.push({ id, metadata, modules });
      return ok({ id });
    }
    if (rest === "/deployments") {
      if (method === "GET") {
        return ok({
          deployments: script.current
            ? [{ versions: [{ version_id: script.current, percentage: 100 }] }]
            : [],
        });
      }
      const versions = b.versions as { version_id: string; percentage: number }[];
      const target = versions[0]?.version_id;
      if (!script.versions.some((v) => v.id === target)) return fail(400, 10215, "unknown version");
      script.current = target;
      return ok({ id: this.id("dep") });
    }
    if (rest === "/secrets") {
      if (method === "PUT") {
        script.secrets.set(String(b.name), String(b.text));
        return ok({ name: b.name, type: "secret_text" });
      }
      return ok([...script.secrets.keys()].map((n) => ({ name: n, type: "secret_text" })));
    }
    if (rest === "/schedules" && method === "PUT") {
      script.schedules = (b as unknown as { cron: string }[]).map((s) => s.cron);
      return ok({ schedules: script.schedules.map((cron) => ({ cron })) });
    }
    if (rest === "/subdomain" && method === "POST") {
      script.workersDev = Boolean(b.enabled);
      return ok({ enabled: script.workersDev });
    }
    return fail(404, 7003, `no route for ${method} /scripts/${name}${rest}`);
  }

  private needsMigration(metadata: Record<string, unknown>) {
    const bindings = (metadata.bindings ?? []) as { type: string; script_name?: string }[];
    return bindings.some((b) => b.type === "durable_object_namespace" && !b.script_name);
  }

  private applySecrets(script: FakeScript, metadata: Record<string, unknown>) {
    const bindings = (metadata.bindings ?? []) as { type: string; name: string; text?: string }[];
    const keep = ((metadata.keep_bindings ?? []) as string[]).includes("secret_text");
    if (!keep) script.secrets.clear();
    for (const binding of bindings) {
      if (binding.type === "secret_text") script.secrets.set(binding.name, String(binding.text));
    }
    // Secrets are not echoed into stored metadata.
    metadata.bindings = bindings.filter((b) => b.type !== "secret_text");
  }

  private async readUpload(form: FormData) {
    const metaPart = form.get("metadata");
    if (!metaPart || typeof metaPart === "string") throw new Error("missing metadata part");
    const metadata = JSON.parse(await metaPart.text()) as Record<string, unknown>;
    const modules = [...form.keys()].filter((k) => k !== "metadata");
    const main = String(metadata.main_module ?? "");
    if (!modules.includes(main)) throw new Error(`main_module ${main} has no part`);
    if (metadata.assets) {
      const jwt = (metadata.assets as { jwt?: string }).jwt ?? "";
      const session = this.sessions.get(jwt);
      if (!session || session.pending.size > 0) throw new Error("assets completion token is not valid");
    }
    return { metadata, modules };
  }
}
