import WebSocket from "ws";
import { ClientMessage, ServerMessage } from "./proto/evergram.js";
import { EvergramConnectionError } from "./errors.js";
import { computeBackoffMs } from "./backoff.js";

export type TransportListener = (msg: ServerMessage) => void;

// Bounds outgoingQueue (see send()/flushQueue() below) for a long-running
// bot that keeps calling send() while disconnected (backoff caps at 30s per
// attempt, but reconnection itself can stall on a dead gateway for much
// longer) — without a cap this queue grows without bound for the life of
// the process. Oldest frames are dropped first, same FIFO tradeoff as
// core.ts's bounded caches.
const MAX_OUTGOING_QUEUE = 1000;

// Node WS transport with reconnect/backoff mirroring the webapp client's own
// HotPocket reconnect logic (exponential backoff with jitter, capped at
// 30s). Auth lives one layer up
// in EvergramCore — a reconnect here always means the session must be
// re-established from scratch (see plan's "edge case — restart do gateway").
export class Transport {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<TransportListener>();
  private readonly openListeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly reconnectingListeners = new Set<(attempt: number) => void>();

  private manuallyClosed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly outgoingQueue: Uint8Array[] = [];

  constructor(private readonly url: string) {}

  onMessage(cb: TransportListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onOpen(cb: () => void): () => void {
    this.openListeners.add(cb);
    return () => this.openListeners.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  onReconnecting(cb: (attempt: number) => void): () => void {
    this.reconnectingListeners.add(cb);
    return () => this.reconnectingListeners.delete(cb);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    this.manuallyClosed = false;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      const onOpen = () => {
        this.reconnectAttempts = 0;
        this.flushQueue();
        for (const cb of this.openListeners) cb();
        resolve();
      };

      const onMessage = (data: WebSocket.RawData) => {
        let msg: ServerMessage;
        try {
          msg = ServerMessage.decode(new Uint8Array(data as Buffer));
        } catch {
          return;
        }
        for (const cb of this.listeners) cb(msg);
      };

      const onClose = () => {
        for (const cb of this.closeListeners) cb();
        if (!this.manuallyClosed) this.scheduleReconnect();
      };

      const onError = (err: Error) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new EvergramConnectionError("connection_failed", err.message));
        }
      };

      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.on("error", onError);
    });
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  send(msg: ClientMessage): void {
    const bytes = ClientMessage.encode(msg).finish();

    if (!this.isOpen()) {
      if (this.outgoingQueue.length >= MAX_OUTGOING_QUEUE) this.outgoingQueue.shift();
      this.outgoingQueue.push(bytes);
      return;
    }

    this.ws!.send(bytes);
  }

  private flushQueue(): void {
    // splice(0) drains and clears in one O(n) pass — repeatedly shift()ing
    // in a loop is O(n) per call, making a full drain O(n^2).
    const queued = this.outgoingQueue.splice(0);
    for (const bytes of queued) this.ws!.send(bytes);
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const attempt = this.reconnectAttempts;
    const delay = computeBackoffMs(attempt, { baseMs: 1000, capMs: 30_000, jitterMs: 500 });

    for (const cb of this.reconnectingListeners) cb(attempt);

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        // onClose will fire again and re-schedule.
      });
    }, delay);
  }
}
