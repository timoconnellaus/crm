// /connect/handoff#<ticket> (ADR 0050): the last page of a gatekeeper connect flow. The
// gatekeeper's final page sends the popup here with a one-time ticket in the fragment (never sent
// to a server). This page redeems it over the signed-in user's own session, with the nonce the
// opener wrote into this popup's sessionStorage before sending it to the provider, so a connect
// link phished into someone else's browser activates nothing. A companion gatekeeper (Slack
// posting) may connect next in the same popup.
import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2Icon, CircleAlertIcon, LoaderIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { connectNonceKey } from "#/components/integrations/connect";
import { callOp } from "#/lib/operations";
import { errorMessage } from "#/lib/query";

export const Route = createFileRoute("/connect/handoff")({
  component: ConnectHandoff,
});

type State =
  | { kind: "working" }
  | { kind: "done"; title: string }
  | { kind: "failed"; message: string };

function ConnectHandoff() {
  const [state, setState] = useState<State>({ kind: "working" });

  useEffect(() => {
    const ticket = decodeURIComponent(window.location.hash.slice(1));
    // Drop the ticket from the address bar and history straight away.
    window.history.replaceState(null, "", window.location.pathname);
    const connectionId = ticket.slice(0, ticket.indexOf("."));
    const key = connectNonceKey(connectionId);
    const nonce = window.sessionStorage.getItem(key);
    if (!ticket || !connectionId || !nonce) {
      setState({
        kind: "failed",
        message:
          "This window did not start a connection. Start again from Settings → Integrations.",
      });
      return;
    }
    window.sessionStorage.removeItem(key);
    callOp("connection.completeConnect", { connectionId, ticket, nonce })
      .then(({ connection, next }) => {
        if (next) {
          window.sessionStorage.setItem(key, next.nonce);
          window.location.replace(next.url);
          return;
        }
        window.opener?.postMessage({ type: "crm-connected", connectionId }, window.location.origin);
        setState({ kind: "done", title: connection.title });
        setTimeout(() => window.close(), 1200);
      })
      .catch((error: unknown) => {
        window.opener?.postMessage(
          { type: "crm-connect-failed", connectionId, message: errorMessage(error) },
          window.location.origin,
        );
        setState({ kind: "failed", message: errorMessage(error) });
      });
  }, []);

  return (
    <main className="mx-auto grid min-h-svh max-w-md place-content-center gap-3 p-6 text-center">
      {state.kind === "working" && (
        <>
          <LoaderIcon className="mx-auto size-6 animate-spin" aria-hidden />
          <p role="status">Finishing the connection…</p>
        </>
      )}
      {state.kind === "done" && (
        <>
          <CheckCircle2Icon className="mx-auto size-8 text-success" aria-hidden />
          <h1 className="text-lg font-semibold">Connected {state.title}</h1>
          <p className="text-muted-foreground">You can close this window.</p>
        </>
      )}
      {state.kind === "failed" && (
        <>
          <CircleAlertIcon className="mx-auto size-8 text-destructive" aria-hidden />
          <h1 className="text-lg font-semibold">The connection was not made</h1>
          <p role="alert" className="text-muted-foreground">
            {state.message}
          </p>
        </>
      )}
    </main>
  );
}
