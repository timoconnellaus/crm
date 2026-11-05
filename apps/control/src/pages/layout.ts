// Server-rendered HTML for the control plane: plain forms that work without JavaScript, and no
// third-party loads (the same rule as the landing page).
import { escapeHtml } from "../util.ts";

export const h = escapeHtml;

/** Marks a string as already-safe HTML for `html`. */
export class Raw {
  constructor(readonly value: string) {}
}
export const raw = (value: string) => new Raw(value);

/** Tagged template: interpolations are escaped unless they are Raw (or arrays of Raw). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    const render = (v: unknown): string =>
      v instanceof Raw
        ? v.value
        : Array.isArray(v)
          ? v.map(render).join("")
          : v === null || v === undefined || v === false
            ? ""
            : escapeHtml(v);
    out += render(value) + (strings[i + 1] ?? "");
  });
  return new Raw(out);
}

const STYLE = `
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--line:#e7e5e4;--card:#fff;--accent:#4338ca;--accent-fg:#fff;--warn:#b45309;--bad:#b91c1c;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#818cf8;--accent-fg:#0c0a09}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{border-bottom:1px solid var(--line);padding:.75rem 1rem;display:flex;gap:1rem;align-items:center;justify-content:space-between}
header a{color:inherit;text-decoration:none;font-weight:600}
main{max-width:60rem;margin:0 auto;padding:1.5rem 1rem 4rem}
h1{font-size:1.5rem;margin:.5rem 0 1rem}h2{font-size:1.1rem;margin:1.5rem 0 .5rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:1rem 1.25rem;margin:1rem 0}
.muted{color:var(--muted)}.warn{color:var(--warn)}.bad{color:var(--bad)}.ok{color:var(--ok)}
label{display:block;margin:.75rem 0 .25rem;font-weight:500}
input,select,textarea{width:100%;max-width:28rem;padding:.5rem .6rem;border:1px solid var(--line);border-radius:.5rem;background:var(--bg);color:var(--fg);font:inherit}
button,.button{display:inline-block;margin-top:.75rem;padding:.5rem .9rem;border:0;border-radius:.5rem;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}button.danger{background:var(--bad);color:#fff}
form.inline{display:inline}form.inline button{margin-right:.5rem}
table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:.75rem}
.plans label{font-weight:400;border:1px solid var(--line);border-radius:.75rem;padding:.75rem;margin:0}
.plans input{width:auto;margin-right:.4rem}
.badge{display:inline-block;padding:0 .45rem;border-radius:999px;border:1px solid var(--line);font-size:.8rem}
.table-wrap{overflow-x:auto}
`;

export function page(
  title: string,
  body: Raw,
  options: { signedIn?: boolean; staff?: boolean; status?: number } = {},
): Response {
  const nav = options.signedIn
    ? html`<nav>${options.staff ? html`<a href="/admin">Admin</a> · ` : ""}<a href="/account">Account</a> · <form class="inline" method="post" action="/signout"><button class="secondary" style="margin:0;padding:.2rem .6rem">Sign out</button></form></nav>`
    : html`<nav><a href="/">Sign in</a></nav>`;
  const doc = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Relationship OS</title><style>${raw(STYLE)}</style></head><body><header><a href="/">Relationship OS</a>${nav}</header><main>${body}</main></body></html>`;
  return new Response(doc.value, {
    status: options.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "x-frame-options": "DENY",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

export function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, ...headers } });
}
