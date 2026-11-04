// Starting a connection (or reconnecting an expired one) from a click: the popup opens blank
// inside the click (so it is not blocked), then connection.create / connection.reconnect gives
// the provider URL and nonce, and /connect/handoff in the popup reports back (see connect.ts).
// Auto-provisioned gatekeepers return no URL: they are active at once and the popup closes.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { callOp } from "#/lib/operations";
import { errorMessage, invalidateOps } from "#/lib/query";
import { openConnectPopup, sendConnectPopup, waitForConnect } from "./connect.ts";

export interface ConnectRequest {
  vendor: string;
  scope: "personal" | "org";
  title: string;
  /** OAuth gatekeepers need the popup; auto-provisioned ones do not. */
  oauth: boolean;
}

export function useConnectFlow() {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([invalidateOps(client, "connection."), invalidateOps(client, "integration.")]);

  async function finish(
    popup: Window | null,
    connectionId: string,
    start: { url: string; nonce: string } | null,
    title: string,
  ) {
    if (!start) {
      popup?.close();
      toast.success(`Connected ${title}`);
      return;
    }
    if (!popup) {
      toast.error("Allow pop-ups for this site to connect, then try again.");
      return;
    }
    sendConnectPopup(popup, { ...start, connectionId });
    const outcome = await waitForConnect(popup, connectionId);
    if (outcome.ok) toast.success(`Connected ${title}`);
    else toast.error(outcome.message);
  }

  /** Call straight from a click handler. */
  function connect({ vendor, scope, title, oauth }: ConnectRequest) {
    const popup = oauth ? openConnectPopup() : null;
    const key = `${vendor}:${scope}`;
    setBusy(key);
    void (async () => {
      try {
        const out = await callOp("connection.create", { vendor, scope, sharingLevel: "metadata" });
        await refresh();
        await finish(popup, out.connection.id, out.connect, title);
      } catch (error) {
        popup?.close();
        toast.error(errorMessage(error));
      } finally {
        setBusy((current) => (current === key ? null : current));
        await refresh();
      }
    })();
  }

  /** Call straight from a click handler. */
  function reconnect(connection: { id: string; title: string }) {
    const popup = openConnectPopup();
    setBusy(connection.id);
    void (async () => {
      try {
        const out = await callOp("connection.reconnect", { id: connection.id });
        await finish(popup, connection.id, out.connect, connection.title);
      } catch (error) {
        popup?.close();
        toast.error(errorMessage(error));
      } finally {
        setBusy((current) => (current === connection.id ? null : current));
        await refresh();
      }
    })();
  }

  return { connect, reconnect, busy };
}
