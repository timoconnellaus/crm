// Opening a provider's WebSocket from a Worker: `fetch` with an Upgrade header is the way to send
// an Authorization header on a socket. The key never goes in a URL.

/** The part of a WebSocket the providers use, so tests can stand in for the far end. */
export interface ProviderSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

export type SocketOpener = (url: string, apiKey: string) => Promise<ProviderSocket>;

/** The default opener. `url` is `wss://…`; the error says only how the provider answered. */
export const openProviderSocket: SocketOpener = async (url, apiKey) => {
  const response = await fetch(url.replace(/^wss:/, "https:"), {
    headers: { Upgrade: "websocket", Authorization: apiKey },
  });
  const socket = (response as Response & { webSocket?: WebSocket | null }).webSocket;
  if (!socket) throw new Error(`The speech provider refused the connection (${response.status})`);
  socket.accept();
  return socket as unknown as ProviderSocket;
};
