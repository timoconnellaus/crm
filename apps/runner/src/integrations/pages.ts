// The fake provider's HTML responses. The handoff page mirrors gatekeeper-kit's
// connectHandoffPageHtml (the final page of every connect flow): it sends the popup to
// `<targetOrigin>/connect/handoff#<ticket>`, where the CRM redeems the ticket over the
// initiating user's session with the popup's nonce. The fragment never reaches a server.

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function connectHandoffPageHtml(handoff: { targetOrigin: string; ticket: string }): string {
  const origin = new URL(handoff.targetOrigin).origin;
  if (origin !== handoff.targetOrigin)
    throw new Error("The handoff's targetOrigin is not an origin");
  const literal = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Connected</title></head>
<body><main><h1>Connected</h1><p>Returning to Relationship OS…</p></main>
<script>
(function () {
  var ticket = ${literal(handoff.ticket)};
  var target = ${literal(origin)};
  window.location.replace(target + "/connect/handoff#" + encodeURIComponent(ticket));
})();
</script></body></html>`;
}
