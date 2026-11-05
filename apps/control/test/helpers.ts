// Drives ros-control like a browser (cookies, same-origin forms) and reads the fakes.
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ControlEnv } from "../src/env.ts";
import { buildServices, type Services } from "../src/services.ts";
import type { FakePlatform } from "../src/testing/fake-platform.ts";

export const ORIGIN = "https://app.relationshiposcrm.com";

export function services(overrides: Partial<ControlEnv> = {}): Services & { fake: FakePlatform } {
  const s = buildServices({ ...(env as ControlEnv), ...overrides }, { origin: ORIGIN });
  if (!s.fake) throw new Error("tests run in fake mode");
  return s as Services & { fake: FakePlatform };
}

export class Browser {
  private cookies = new Map<string, string>();

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    const headers = new Headers(init.headers);
    if (this.cookies.size) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const response = await SELF.fetch(url, { ...init, headers, redirect: "manual" });
    const set = response.headers.get("set-cookie");
    if (set) {
      const [pair] = set.split(";");
      const [k, ...v] = (pair ?? "").split("=");
      if (k) this.cookies.set(k, v.join("="));
    }
    return response;
  }

  get(path: string) {
    return this.request(path);
  }

  post(path: string, fields: Record<string, string> = {}) {
    return this.request(path, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    });
  }

  /** Follows one redirect chain (relative or to our origin), returning the last response. */
  async follow(response: Response, max = 10): Promise<Response> {
    let current = response;
    for (let i = 0; i < max && current.status >= 300 && current.status < 400; i++) {
      const location = current.headers.get("location") as string;
      if (!location.startsWith("/") && !location.startsWith(ORIGIN)) return current;
      current = await this.get(location);
    }
    return current;
  }
}

/** The newest sign-in link mailed to `email`, as a path. */
export async function signInLink(email: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT body FROM cp_dev_mail WHERE to_address = ? AND subject LIKE 'Sign in%' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(email.toLowerCase())
    .first<{ body: string }>();
  const match = /\/auth\/callback\?token=[\w-]+/.exec(row?.body ?? "");
  if (!match) throw new Error(`no sign-in link for ${email}`);
  return match[0];
}

/** Signs up and confirms the email; returns the browser, signed in, after /account/start. */
export async function signUp(input: { email: string; slug: string; plan: string; name?: string }) {
  const browser = new Browser();
  const response = await browser.post("/signup", {
    email: input.email,
    name: input.name ?? input.slug,
    slug: input.slug,
    plan: input.plan,
  });
  if (response.status !== 200) throw new Error(`sign-up failed: ${response.status}`);
  const callback = await browser.get(await signInLink(input.email));
  const start = await browser.get(callback.headers.get("location") as string);
  return { browser, start };
}

export async function instanceFor(slug: string) {
  return env.DB.prepare("SELECT * FROM cp_instances WHERE slug = ?")
    .bind(slug)
    .first<Record<string, string | null>>();
}

/** A request to a tenant hostname through the dispatch logic and the fake namespace. */
export function tenantFetch(s: Services, url: string) {
  return s.healthFetch(url);
}

export async function tenantQuery<T = Record<string, unknown>>(
  s: Services,
  slug: string,
  sql: string,
  params: (string | number | null)[] = [],
): Promise<T[]> {
  const instance = await instanceFor(slug);
  const [first] = await s.cf.queryD1<T>(s.accountId, instance?.database_id as string, sql, params);
  return first?.results ?? [];
}
