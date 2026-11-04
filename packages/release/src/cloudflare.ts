// A small typed client for the Cloudflare REST API (v4), with `fetch` only: the CLI and the
// self-updater deploy without wrangler (ADR 0163). Endpoints and shapes are cited in ADR 0163.
//
// The client never logs, and errors carry the API's messages but never request bodies, so a
// token or secret value cannot end up in output.

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export class CloudflareApiError extends Error {
  override name = "CloudflareApiError";
  readonly status: number;
  readonly codes: number[];
  constructor(message: string, status: number, codes: number[]) {
    super(message);
    this.status = status;
    this.codes = codes;
  }
}

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page?: number; total_pages?: number; cursor?: string };
}

export interface ModulePart {
  name: string;
  type: "esm" | "text" | "data" | "wasm";
  bytes: Uint8Array;
}

const CONTENT_TYPES: Record<ModulePart["type"], string> = {
  esm: "application/javascript+module",
  text: "text/plain",
  data: "application/octet-stream",
  wasm: "application/wasm",
};

export interface ScriptInfo {
  id: string;
  migration_tag?: string;
}

export interface CloudflareClientOptions {
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

export class CloudflareClient {
  readonly apiBase: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CloudflareClientOptions) {
    this.token = options.token;
    this.apiBase = options.apiBase ?? CLOUDFLARE_API;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init: { headers?: Record<string, string>; raw?: BodyInit; auth?: string } = {},
  ): Promise<{ result: T; info?: Envelope<T>["result_info"] }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${init.auth ?? this.token}`,
      ...init.headers,
    };
    let payload: BodyInit | undefined = init.raw;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers,
      body: payload,
    });
    let envelope: Envelope<T> | null = null;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      envelope = null;
    }
    if (!response.ok || !envelope?.success) {
      const errors = envelope?.errors ?? [];
      const detail = errors.map((e) => `${e.code}: ${e.message}`).join("; ") || response.statusText;
      throw new CloudflareApiError(
        `${method} ${path.replace(/\?.*$/, "")} failed (HTTP ${response.status}): ${detail}`,
        response.status,
        errors.map((e) => e.code),
      );
    }
    return { result: envelope.result, info: envelope.result_info };
  }

  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page < 100; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const { result, info } = await this.request<T[]>(
        "GET",
        `${path}${sep}page=${page}&per_page=50`,
      );
      out.push(...result);
      if (!info?.total_pages || page >= info.total_pages || result.length === 0) break;
    }
    return out;
  }

  // ---- Token, accounts, zones ---------------------------------------------------------------

  /** Verifies the token (user-owned, then account-owned). Returns its status. */
  async verifyToken(accountId?: string): Promise<{ id: string; status: string }> {
    try {
      return (await this.request<{ id: string; status: string }>("GET", "/user/tokens/verify"))
        .result;
    } catch (error) {
      if (!accountId) throw error;
      return (
        await this.request<{ id: string; status: string }>(
          "GET",
          `/accounts/${accountId}/tokens/verify`,
        )
      ).result;
    }
  }

  listAccounts() {
    return this.all<{ id: string; name: string }>("/accounts");
  }

  listZones(accountId: string) {
    return this.all<{ id: string; name: string; status: string }>(
      `/zones?account.id=${encodeURIComponent(accountId)}&status=active`,
    );
  }

  async workersSubdomain(accountId: string): Promise<string | null> {
    try {
      return (
        await this.request<{ subdomain: string }>("GET", `/accounts/${accountId}/workers/subdomain`)
      ).result.subdomain;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createWorkersSubdomain(accountId: string, subdomain: string) {
    return (
      await this.request<{ subdomain: string }>("PUT", `/accounts/${accountId}/workers/subdomain`, {
        subdomain,
      })
    ).result.subdomain;
  }

  // ---- Storage resources ----------------------------------------------------------------------

  async listD1(accountId: string) {
    return (
      await this.request<{ uuid: string; name: string }[]>(
        "GET",
        `/accounts/${accountId}/d1/database?per_page=10000`,
      )
    ).result;
  }

  async createD1(accountId: string, name: string) {
    return (
      await this.request<{ uuid: string; name: string }>(
        "POST",
        `/accounts/${accountId}/d1/database`,
        {
          name,
        },
      )
    ).result;
  }

  async deleteD1(accountId: string, id: string) {
    await this.request("DELETE", `/accounts/${accountId}/d1/database/${id}`);
  }

  /** Runs SQL (several `;`-separated statements run as one batch). */
  async queryD1<Row = Record<string, unknown>>(
    accountId: string,
    databaseId: string,
    sql: string,
    params: (string | number | null)[] = [],
  ): Promise<{ results: Row[] }[]> {
    return (
      await this.request<{ results: Row[] }[]>(
        "POST",
        `/accounts/${accountId}/d1/database/${databaseId}/query`,
        { sql, params },
      )
    ).result;
  }

  /** The current D1 Time Travel bookmark (or the one at `timestamp`). */
  async d1Bookmark(accountId: string, databaseId: string, timestamp?: string): Promise<string> {
    const query = timestamp ? `?timestamp=${encodeURIComponent(timestamp)}` : "";
    return (
      await this.request<{ bookmark: string }>(
        "GET",
        `/accounts/${accountId}/d1/database/${databaseId}/time_travel/bookmark${query}`,
      )
    ).result.bookmark;
  }

  /** Restores a database to a bookmark, in place. Returns the bookmark that undoes it. */
  async d1Restore(accountId: string, databaseId: string, bookmark: string) {
    return (
      await this.request<{ bookmark: string; previous_bookmark: string }>(
        "POST",
        `/accounts/${accountId}/d1/database/${databaseId}/time_travel/restore?bookmark=${encodeURIComponent(bookmark)}`,
      )
    ).result;
  }

  async listR2(accountId: string) {
    return (
      await this.request<{ buckets: { name: string }[] }>(
        "GET",
        `/accounts/${accountId}/r2/buckets?per_page=1000`,
      )
    ).result.buckets;
  }

  async createR2(accountId: string, name: string) {
    await this.request("POST", `/accounts/${accountId}/r2/buckets`, { name });
  }

  async deleteR2(accountId: string, name: string) {
    await this.request("DELETE", `/accounts/${accountId}/r2/buckets/${name}`);
  }

  listKv(accountId: string) {
    return this.all<{ id: string; title: string }>(`/accounts/${accountId}/storage/kv/namespaces`);
  }

  async createKv(accountId: string, title: string) {
    return (
      await this.request<{ id: string; title: string }>(
        "POST",
        `/accounts/${accountId}/storage/kv/namespaces`,
        { title },
      )
    ).result;
  }

  async deleteKv(accountId: string, id: string) {
    await this.request("DELETE", `/accounts/${accountId}/storage/kv/namespaces/${id}`);
  }

  listQueues(accountId: string) {
    return this.all<{
      queue_id: string;
      queue_name: string;
      consumers?: { consumer_id?: string; script_name?: string; script?: string }[];
    }>(`/accounts/${accountId}/queues`);
  }

  async createQueue(accountId: string, name: string) {
    return (
      await this.request<{ queue_id: string; queue_name: string }>(
        "POST",
        `/accounts/${accountId}/queues`,
        { queue_name: name },
      )
    ).result;
  }

  async deleteQueue(accountId: string, id: string) {
    await this.request("DELETE", `/accounts/${accountId}/queues/${id}`);
  }

  async putQueueConsumer(
    accountId: string,
    queueId: string,
    scriptName: string,
    settings: Record<string, unknown>,
    existingConsumerId?: string,
  ) {
    const body = { type: "worker", script_name: scriptName, settings };
    if (existingConsumerId) {
      await this.request(
        "PUT",
        `/accounts/${accountId}/queues/${queueId}/consumers/${existingConsumerId}`,
        body,
      );
    } else {
      await this.request("POST", `/accounts/${accountId}/queues/${queueId}/consumers`, body);
    }
  }

  async listVectorize(accountId: string) {
    return (
      await this.request<{ name: string }[]>("GET", `/accounts/${accountId}/vectorize/v2/indexes`)
    ).result;
  }

  async createVectorize(accountId: string, name: string, config: Record<string, unknown>) {
    await this.request("POST", `/accounts/${accountId}/vectorize/v2/indexes`, { name, config });
  }

  async deleteVectorize(accountId: string, name: string) {
    await this.request("DELETE", `/accounts/${accountId}/vectorize/v2/indexes/${name}`);
  }

  // ---- Workers --------------------------------------------------------------------------------

  async listScripts(accountId: string): Promise<ScriptInfo[]> {
    return (await this.request<ScriptInfo[]>("GET", `/accounts/${accountId}/workers/scripts`))
      .result;
  }

  private form(metadata: Record<string, unknown>, modules: ModulePart[]): FormData {
    const form = new FormData();
    form.set(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      "metadata.json",
    );
    for (const module of modules) {
      form.set(
        module.name,
        new Blob([module.bytes as Uint8Array<ArrayBuffer>], { type: CONTENT_TYPES[module.type] }),
        module.name,
      );
    }
    return form;
  }

  /** Uploads and deploys a script (needed for a first deploy and for Durable Object migrations). */
  async putScript(
    accountId: string,
    name: string,
    metadata: Record<string, unknown>,
    modules: ModulePart[],
  ) {
    return (
      await this.request<{ id: string; migration_tag?: string }>(
        "PUT",
        `/accounts/${accountId}/workers/scripts/${name}`,
        undefined,
        { raw: this.form(metadata, modules) },
      )
    ).result;
  }

  /** Uploads a version without moving traffic to it. */
  async uploadVersion(
    accountId: string,
    name: string,
    metadata: Record<string, unknown>,
    modules: ModulePart[],
  ): Promise<string> {
    return (
      await this.request<{ id: string }>(
        "POST",
        `/accounts/${accountId}/workers/scripts/${name}/versions`,
        undefined,
        { raw: this.form(metadata, modules) },
      )
    ).result.id;
  }

  /** Sends 100% of traffic to a version. */
  async deployVersion(accountId: string, name: string, versionId: string, message?: string) {
    await this.request("POST", `/accounts/${accountId}/workers/scripts/${name}/deployments`, {
      strategy: "percentage",
      versions: [{ version_id: versionId, percentage: 100 }],
      ...(message ? { annotations: { "workers/message": message } } : {}),
    });
  }

  /** The version currently taking all traffic, or null. */
  async currentVersion(accountId: string, name: string): Promise<string | null> {
    const { result } = await this.request<{
      deployments: { versions: { version_id: string; percentage: number }[] }[];
    }>("GET", `/accounts/${accountId}/workers/scripts/${name}/deployments`);
    const latest = result.deployments[0];
    return latest?.versions.find((v) => v.percentage === 100)?.version_id ?? null;
  }

  async deleteScript(accountId: string, name: string) {
    await this.request("DELETE", `/accounts/${accountId}/workers/scripts/${name}?force=true`);
  }

  async listSecrets(accountId: string, name: string): Promise<string[]> {
    return (
      await this.request<{ name: string }[]>(
        "GET",
        `/accounts/${accountId}/workers/scripts/${name}/secrets`,
      )
    ).result.map((s) => s.name);
  }

  async putSecret(accountId: string, name: string, secret: string, value: string) {
    await this.request("PUT", `/accounts/${accountId}/workers/scripts/${name}/secrets`, {
      name: secret,
      text: value,
      type: "secret_text",
    });
  }

  async putSchedules(accountId: string, name: string, crons: string[]) {
    await this.request(
      "PUT",
      `/accounts/${accountId}/workers/scripts/${name}/schedules`,
      crons.map((cron) => ({ cron })),
    );
  }

  async setWorkersDev(accountId: string, name: string, enabled: boolean) {
    await this.request("POST", `/accounts/${accountId}/workers/scripts/${name}/subdomain`, {
      enabled,
      previews_enabled: false,
    });
  }

  async putDomain(accountId: string, hostname: string, service: string, zoneId: string) {
    await this.request("PUT", `/accounts/${accountId}/workers/domains`, {
      hostname,
      service,
      zone_id: zoneId,
      environment: "production",
    });
  }

  // ---- Static assets (direct upload) ----------------------------------------------------------

  /** Starts an assets upload session; returns the JWT and the hashes the API still needs. */
  async assetsUploadSession(
    accountId: string,
    name: string,
    manifest: Record<string, { hash: string; size: number }>,
  ) {
    return (
      await this.request<{ jwt: string; buckets?: string[][] }>(
        "POST",
        `/accounts/${accountId}/workers/scripts/${name}/assets-upload-session`,
        { manifest },
      )
    ).result;
  }

  /** Uploads one bucket of assets (base64 parts named by hash). Returns the completion JWT, if any. */
  async uploadAssets(
    accountId: string,
    jwt: string,
    files: { hash: string; base64: string; contentType: string }[],
  ): Promise<string | undefined> {
    const form = new FormData();
    for (const file of files) {
      form.set(file.hash, new Blob([file.base64], { type: file.contentType }), file.hash);
    }
    const { result } = await this.request<{ jwt?: string } | null>(
      "POST",
      `/accounts/${accountId}/workers/assets/upload?base64=true`,
      undefined,
      { raw: form, auth: jwt },
    );
    return result?.jwt;
  }
}
