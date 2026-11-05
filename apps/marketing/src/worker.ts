// ros-marketing: static assets (the Astro build) plus one endpoint, POST /api/signup, for the
// waitlist and contact-sales form. The form works without JavaScript: a browser POST is answered
// with a redirect to a static page (/thanks/, /check-form/ or /try-later/); `accept: application/json`
// gets JSON instead.
import { formFields, HONEYPOT, SignupInput, saveSignup } from "./signup.ts";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function wantsJson(request: Request) {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

function reply(request: Request, ok: boolean, status: number, error?: string) {
  if (wantsJson(request)) {
    return Response.json(ok ? { ok } : { ok, error }, { status, headers: SECURITY_HEADERS });
  }
  const to = ok ? "/thanks/" : error === "rate_limited" ? "/try-later/" : "/check-form/";
  return new Response(null, {
    status: 303,
    headers: { ...SECURITY_HEADERS, location: new URL(to, request.url).toString() },
  });
}

async function signup(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const { success } = await env.FORM_RATE_LIMIT.limit({ key: ip });
  if (!success) return reply(request, false, 429, "rate_limited");
  let fields: Record<string, string>;
  try {
    fields = formFields(await request.formData());
  } catch {
    return reply(request, false, 400, "invalid");
  }
  // A filled honeypot looks like success to the bot, and stores nothing.
  if (fields[HONEYPOT]) return reply(request, true, 200);
  const parsed = SignupInput.safeParse(fields);
  if (!parsed.success) return reply(request, false, 400, "invalid");
  await saveSignup(env.DB, parsed.data);
  return reply(request, true, 200);
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
