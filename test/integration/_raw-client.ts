import WebSocket from "ws";
import { ClientMessage, ServerMessage } from "../../src/proto/evergram";

// A deliberately low-level WS client for the auth integration tests below —
// EvergramCore always builds a *correctly* signed Auth from a nonce it just
// received, so it can't express the adversarial cases we need to prove are
// rejected (replaying a signature bound to a different connection's nonce,
// sending a second auth on an already-consumed nonce). This talks the wire
// protocol directly instead.
export interface RawClient {
  send(msg: ClientMessage): void;
  waitFor<K extends keyof ServerMessage>(field: K, timeoutMs?: number): Promise<NonNullable<ServerMessage[K]>>;
  close(): void;
}

export function openRawConnection(url: string): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    type Waiter = { field: string; resolve: (v: any) => void; timer: NodeJS.Timeout };
    const waiters: Waiter[] = [];

    ws.on("message", (data) => {
      let msg: ServerMessage;
      try {
        msg = ServerMessage.decode(new Uint8Array(data as Buffer));
      } catch {
        return;
      }

      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        const value = (msg as any)[waiter.field];
        if (value !== undefined) {
          waiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(value);
        }
      }
    });

    ws.once("open", () => {
      resolve({
        send: (msg) => ws.send(ClientMessage.encode(msg).finish()),
        waitFor: (field, timeoutMs = 10000) =>
          new Promise((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error(`timeout waiting for ServerMessage.${String(field)}`)),
              timeoutMs
            );
            waiters.push({ field: String(field), resolve: res, timer });
          }),
        close: () => ws.close(),
      });
    });

    ws.once("error", reject);
  });
}
