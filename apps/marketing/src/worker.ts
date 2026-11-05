// ros-marketing: static assets (the Astro build) plus one endpoint, POST /api/signup, for the
// waitlist and contact-sales forms. The forms work without JavaScript: a browser POST is answered
// with a redirect. A waitlist signup goes back to the landing page, to its form's "You're on the
// list" message (/#joined-hero or /#joined-waitlist); a sales request goes to /thanks/; a problem
// goes to /check-form/ or /try-later/. `accept: application/json` gets JSON instead.
import { formFields, HONEYPOT, SignupInput, saveSignup } from "./signup.ts";
import { FORM_SOURCES, type FormSource, joinedAnchor } from "./team-size.ts";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function wantsJson(request: Request) {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

type Outcome =
  | { ok: true; kind: "waitlist" | "sales"; source?: FormSource }
  | { ok: false; error: "invalid" | "rate_limited" };

function successPath(outcome: Extract<Outcome, { ok: true }>) {
  if (outcome.kind === "sales") return "/thanks/";
  return `/#${joinedAnchor(outcome.source ?? "waitlist")}`;
}

function reply(request: Request, outcome: Outcome, status: number) {
  if (wantsJson(request)) {
    const body = outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
    return Response.json(body, { status, headers: SECURITY_HEADERS });
  }
  const to = outcome.ok
    ? successPath(outcome)
    : outcome.error === "rate_limited"
      ? "/try-later/"
      : "/check-form/";
  return new Response(null, {
    status: 303,
    headers: { ...SECURITY_HEADERS, location: new URL(to, request.url).toString() },
  });
}

/** The form a submission came from, if it names a known one (used only to pick the redirect). */
function sourceOf(fields: Record<string, string>): FormSource | undefined {
  return FORM_SOURCES.find((source) => source === fields.source);
}

async function signup(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const { success } = await env.FORM_RATE_LIMIT.limit({ key: ip });
  if (!success) return reply(request, { ok: false, error: "rate_limited" }, 429);
  let fields: Record<string, string>;
  try {
    fields = formFields(await request.formData());
  } catch {
    return reply(request, { ok: false, error: "invalid" }, 400);
  }
  // A filled honeypot looks like success to the bot, and stores nothing.
  if (fields[HONEYPOT]) {
    const kind = fields.kind === "sales" ? "sales" : "waitlist";
    return reply(request, { ok: true, kind, source: sourceOf(fields) }, 200);
  }
  const parsed = SignupInput.safeParse(fields);
  if (!parsed.success) return reply(request, { ok: false, error: "invalid" }, 400);
  await saveSignup(env.DB, parsed.data);
  return reply(request, { ok: true, kind: parsed.data.kind, source: parsed.data.source }, 200);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/signup") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
      }
      return signup(request, env);
    }
    if (url.pathname.startsWith("/api/")) return new Response("Not Found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
