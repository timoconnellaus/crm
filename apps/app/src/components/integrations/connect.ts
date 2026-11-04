// The browser half of a gatekeeper connect flow (ADR 0050). The popup is opened blank in the
// click handler (so it is not blocked), given the flow's nonce in its own sessionStorage, then sent
// to the provider. Its last stop is /connect/handoff, which redeems the ticket with that nonce and
// tells this window how it went.

export function connectNonceKey(connectionId: string): string {
  return `crm-connect:${connectionId}`;
}

/** Opens an empty popup synchronously, inside the user's click. */
export function openConnectPopup(): Window | null {
  return window.open("", "crm-connect", "popup,width=520,height=720");
}

/** Hands the popup its nonce and sends it to the provider's connect page. */
export function sendConnectPopup(
  popup: Window,
  start: { url: string; nonce: string; connectionId: string },
): void {
  popup.sessionStorage.setItem(connectNonceKey(start.connectionId), start.nonce);
  popup.location.href = new URL(start.url, window.location.origin).toString();
}

export type ConnectOutcome = { ok: true } | { ok: false; message: string };

/** Resolves when /connect/handoff in the popup reports back (or the popup is closed). */
export function waitForConnect(popup: Window, connectionId: string): Promise<ConnectOutcome> {
  return new Promise((resolve) => {
    const done = (outcome: ConnectOutcome) => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
      resolve(outcome);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; connectionId?: string; message?: string };
      if (data?.connectionId !== connectionId) return;
      if (data.type === "crm-connected") done({ ok: true });
      if (data.type === "crm-connect-failed")
        done({ ok: false, message: data.message ?? "Failed" });
    };
    window.addEventListener("message", onMessage);
    const timer = window.setInterval(() => {
      if (popup.closed) done({ ok: false, message: "The window was closed before connecting" });
    }, 500);
  });
}
