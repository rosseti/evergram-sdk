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

// Heartbeat: a long-idle bot connection behind a proxy/load balancer can
// have its TCP session silently dropped with neither side ever seeing a
// close frame — nothing here otherwise notices until the next send fails
// or the gateway's own idle timeout (if any) eventually closes it. A
// WebSocket ping with no pong inside HEARTBEAT_TIMEOUT_MS is treated as a
// dead connection and torn down via terminate(), which onClose picks up
// like any other drop and reconnects from.
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

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
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatTimeout: NodeJS.Timeout | null = null;
  // Lets a NEW connect() call reject a still-pending PREVIOUS one instead of
  // silently abandoning it — see connect()'s own comment below.
  private inFlightConnectReject: ((err: Error) => void) | null = null;

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
    // A caller invoking connect() again while a previous call is still
    // waiting on its own socket to open would otherwise silently abandon
    // that first call: every handler below guards on `ws === this.ws` and
    // no-ops once superseded (see that guard's own comment), so the first
    // call's promise settled neither resolve nor reject and just hung
    // forever once `this.ws` was reassigned. Reject it now, and stop the
    // socket it was waiting on, before starting the new one.
    if (this.inFlightConnectReject) {
      const reject = this.inFlightConnectReject;
      this.inFlightConnectReject = null;
      reject(
        new EvergramConnectionError(
          "connect_superseded",
          "A newer connect() call superseded this one",
        ),
      );
    }
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.stopHeartbeat();
      this.ws.terminate();
    }

    this.manuallyClosed = false;

    return new Promise((resolve, reject) => {
      this.inFlightConnectReject = reject;
      const ws = new WebSocket(this.url);
      this.ws = ws;

      // Every handler below guards on `ws === this.ws`: connect() calling
      // close() then immediately connect() again (see EvergramCore's
      // reconnectAndAuthenticate) resets `manuallyClosed` back to false
      // before the OLD socket's own "close" event has fired — Node's ws
      // close is asynchronous, so it can arrive well after a newer `this.ws`
      // is already in place. Without this guard, that stale close event
      // reads the CURRENT (reset) manuallyClosed flag, mistakes an
      // intentional close for a dropped connection, and calls
      // scheduleReconnect() on top of the perfectly healthy new connection —
      // confirmed empirically: a bare close()+connect() produced 9+ cascading
      // reconnect cycles, each one's own eventual stale close re-triggering
      // the next. The same staleness applies to onOpen/onMessage/onError —
      // a handler bound to a socket that's since been superseded should
      // never touch shared state or settle this specific connect() call.
      const onOpen = () => {
        if (ws !== this.ws) return;
        this.reconnectAttempts = 0;
        this.startHeartbeat(ws);
        // Deliberately NOT flushing outgoingQueue here — the socket is open
        // but not yet authenticated on this connection (EvergramCore's
        // authenticate() runs from an openListener below). Flushing now
        // would send anything queued while disconnected straight onto an
        // unauthenticated session. EvergramCore calls flushQueue() itself
        // once auth succeeds — see its onOpen handler.
        for (const cb of this.openListeners) cb();
        this.inFlightConnectReject = null;
        resolve();
      };

      const onMessage = (data: WebSocket.RawData) => {
        if (ws !== this.ws) return;
        let msg: ServerMessage;
        try {
          msg = ServerMessage.decode(new Uint8Array(data as Buffer));
        } catch {
          return;
        }
        for (const cb of this.listeners) cb(msg);
      };

      const onClose = () => {
        if (ws !== this.ws) return;
        this.stopHeartbeat();
        for (const cb of this.closeListeners) cb();
        if (!this.manuallyClosed) this.scheduleReconnect();
      };

      const onError = (err: Error) => {
        if (ws !== this.ws) return;
        if (ws.readyState !== WebSocket.OPEN) {
          this.inFlightConnectReject = null;
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
    this.stopHeartbeat();
    this.ws?.close();
  }

  // Sends a WebSocket ping every HEARTBEAT_INTERVAL_MS while `ws` stays the
  // current socket; a pong reply (see onPong below) cancels the matching
  // HEARTBEAT_TIMEOUT_MS deadline. No pong in time means the connection is
  // presumed dead — see HEARTBEAT_TIMEOUT_MS's comment above.
  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      if (ws !== this.ws || ws.readyState !== WebSocket.OPEN) return;
      this.heartbeatTimeout = setTimeout(() => ws.terminate(), HEARTBEAT_TIMEOUT_MS);
      ws.ping();
    }, HEARTBEAT_INTERVAL_MS);

    const onPong = () => {
      if (ws !== this.ws || !this.heartbeatTimeout) return;
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    };
    ws.on("pong", onPong);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    this.heartbeatInterval = null;
    this.heartbeatTimeout = null;
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

  // Called by EvergramCore once a connection has successfully
  // (re-)authenticated — see connect()'s onOpen comment above for why this
  // can't just run automatically on socket open.
  flushQueue(): void {
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
