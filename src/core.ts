import { EventEmitter } from "node:events";
import {
  ChainFamily,
  ChatInfo,
  ClientMessage,
  Envelope,
  ServerMessage,
} from "./proto/evergram";
import { Transport } from "./transport";
import { EvergramWallet, signAuthChallenge } from "./wallet";
import { identityKey } from "./identity";
import {
  decryptMessage,
  encryptMessage,
  generateMsgId,
  openSealedSymKey,
} from "./crypto";
import {
  EvergramAuthError,
  EvergramNotFoundError,
  EvergramTimeoutError,
  EvergramValidationError,
  errorFromCode,
} from "./errors";
import { MessageContent, parseMessageContent } from "./message-content";

export interface EvergramDevice {
  deviceId: string;
  devicePubHex: string;
  devicePrivHex: string;
}

export interface EvergramCoreOptions {
  /** Gateway WebSocket URL, e.g. "ws://localhost:9000/api/ws". */
  url: string;
  /** XRPL wallet used to sign the auth challenge. See wallet.ts. */
  wallet: EvergramWallet;
  /**
   * This bot's E2EE device keypair. The SDK never persists this for you —
   * generate once with crypto.ts's generateDeviceKeypair() and persist it
   * yourself (see README "Device keys" section). Losing this key means
   * losing access to chat history, same limitation the webapp client has.
   */
  device: EvergramDevice;
  /** Mirrors the contract's EVERGRAM_MAX_PARTICIPANTS (default 100). */
  maxParticipants?: number;
  /**
   * Mirrors the gateway's NEXT_PUBLIC_MAX_MESSAGE_SIZE. Unset by default —
   * the SDK has no way to know your deployment's configured value, so
   * client-side validation is skipped unless you provide it. The server
   * enforces this regardless; this option only saves a round-trip.
   */
  maxMessageSize?: number;
  /** Per-request timeout in ms. Default 20000. */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  expectedField: keyof ServerMessage;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface EvergramChatMessage {
  chatId: string;
  sender: string;
  msgId: string;
  ts: number;
  text: string | null;
  /** Typed view of `text` — switch on `.type` instead of parsing `text` yourself. */
  content: MessageContent;
}

// Low-level, faithful mirror of the wire protocol — see webapp/app/lib/evergram-client.ts
// for the browser equivalent this is modeled on. EvergramBot (bot.ts) wraps
// this with an ergonomic API; use Core directly when you need control over
// the raw protocol (e.g. a non-chat integration).
//
// Events: "connected", "authenticated", "disconnected", "reconnecting" (attempt),
// "message" (EvergramChatMessage), "typing", "delivery", "chatKeyRotated" ({chatId}),
// "joinRequested" (JoinRequestedEvent), "restricted" (ReputationUpdated), "error" (Error).
export class EvergramCore extends EventEmitter {
  private readonly transport: Transport;
  private readonly wallet: EvergramWallet;
  private readonly device: EvergramDevice;
  private readonly identity = { chainFamily: ChainFamily.XRPL, address: "" } as { chainFamily: ChainFamily; address: string };
  private readonly selfIdentityKey: string;
  private readonly maxParticipants: number;
  private readonly maxMessageSize?: number;
  private readonly requestTimeoutMs: number;

  private readonly pendingRequests: PendingRequest[] = [];
  private readonly chats = new Map<string, ChatInfo>();
  private readonly symKeys = new Map<string, Uint8Array>();
  private readonly pendingEnvelopes = new Map<string, Envelope[]>();

  private authenticated = false;
  isRestricted = false;

  constructor(opts: EvergramCoreOptions) {
    super();

    this.wallet = opts.wallet;
    this.device = opts.device;
    this.identity.address = opts.wallet.address;
    this.selfIdentityKey = identityKey(this.identity as any);
    this.maxParticipants = opts.maxParticipants ?? 100;
    this.maxMessageSize = opts.maxMessageSize;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;

    this.transport = new Transport(opts.url);

    this.transport.onOpen(() => {
      this.emit("connected");
      this.authenticate()
        .then(() => {
          this.authenticated = true;
          // Mirrors webapp/app/lib/evergram-client.ts, which does the same
          // right after auth (see its ensureAuthSessionReady/syncChats call
          // before onSessionFullyReady()). Without this, a fresh process —
          // or even a reconnect — has an empty `chats`/`symKeys` map and
          // silently swallows envelopes for any chat that existed before
          // this connection, since nothing else ever re-populates them.
          this.syncChats();
          this.emit("authenticated");
        })
        .catch((err) => this.emit("error", err));
    });

    this.transport.onClose(() => {
      this.authenticated = false;
      this.emit("disconnected");
    });

    this.transport.onReconnecting((attempt) => this.emit("reconnecting", attempt));

    this.transport.onMessage((msg) => this.handleServerMessage(msg));
  }

  // Resolves once the WebSocket is open AND the signed_message auth flow
  // has completed. Reconnects after this (network blip, gateway restart)
  // re-authenticate automatically in the background — listen for
  // "authenticated"/"error" if you want to observe that.
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAuthenticated = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.off("authenticated", onAuthenticated);
        this.off("error", onError);
      };

      this.once("authenticated", onAuthenticated);
      this.once("error", onError);

      this.transport.connect().catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  close(): void {
    this.transport.close();
  }

  // Self-heals a brand-new bot identity's first connection: the gateway
  // accepts the WebSocket session as soon as the wallet signature checks
  // out (see webapp/app/gateway/index.ts's handleAuthIfNeeded), but the
  // *contract* separately rejects authResponse with device_not_registered
  // until registerDevice has run — confirmed empirically against the local
  // gateway. Register once and retry rather than making every bot author
  // special-case this on first run.
  private async authenticate(): Promise<void> {
    const challenge = await this.waitForMessage("authChallenge");
    const proof = signAuthChallenge(this.wallet, this.device.deviceId, challenge.nonce);

    const msg = ClientMessage.create({
      auth: {
        identity: this.identity,
        proof: { signedMessage: proof },
        device: { deviceId: this.device.deviceId, devicePubHex: this.device.devicePubHex },
      },
    });

    try {
      await this.request(msg, "authResponse");
    } catch (err) {
      if (err instanceof EvergramNotFoundError && err.code === "device_not_registered") {
        const registerMsg = ClientMessage.create({
          registerDevice: {
            identity: this.identity,
            device: { deviceId: this.device.deviceId, devicePubHex: this.device.devicePubHex },
          },
        });
        await this.request(registerMsg, "registerDeviceResponse");
        await this.request(msg, "authResponse");
        return;
      }
      throw err;
    }
  }

  async registerDevice() {
    const msg = ClientMessage.create({
      registerDevice: {
        identity: this.identity,
        device: { deviceId: this.device.deviceId, devicePubHex: this.device.devicePubHex },
      },
    });

    return this.requestWithReauth(msg, "registerDeviceResponse");
  }

  // No capability/tier gate on the contract side — any authenticated
  // identity can set its own nickname/avatar/bio. Useful for giving a bot a
  // human-readable name instead of a raw address in chat UIs.
  async setProfile(opts: { nickname?: string; avatarUrl?: string; bio?: string }) {
    const msg = ClientMessage.create({
      changeProfile: { nickname: opts.nickname, avatarUrl: opts.avatarUrl, bio: opts.bio },
    });

    return this.requestWithReauth(msg, "changeProfileResponse");
  }

  async createChat(type: "one-on-one" | "group", participants: string[], meta?: any) {
    if (participants.length > this.maxParticipants) {
      throw new EvergramValidationError(
        "too_many_participants",
        `${participants.length} participants exceeds the configured limit of ${this.maxParticipants}`
      );
    }

    const msg = ClientMessage.create({
      createChat: {
        type,
        participants,
        meta,
        device: { deviceId: this.device.deviceId, devicePubHex: this.device.devicePubHex },
      },
    });

    const resp = await this.requestWithReauth(msg, "createChatResponse");
    if (resp.chat) this.processChatInfo(resp.chat);
    return resp;
  }

  async sendMessage(chatId: string, text: string) {
    if (this.maxMessageSize !== undefined) {
      const byteLength = Buffer.byteLength(text, "utf8");
      if (byteLength > this.maxMessageSize) {
        throw new EvergramValidationError(
          "message_too_large",
          `Message is ${byteLength} bytes, exceeding the configured limit of ${this.maxMessageSize}`
        );
      }
    }

    const symKey = this.symKeys.get(chatId);
    if (!symKey) {
      throw new EvergramNotFoundError("chat_key_unknown", `No symmetric key known for chat ${chatId} yet — call syncChats() or wait for the chat to be established`);
    }

    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new EvergramNotFoundError("chat_not_found", `Unknown chat ${chatId}`);
    }

    const encrypted = encryptMessage(symKey, text);
    const msgId = generateMsgId();

    const env = Envelope.create({
      type: "SEND",
      device: { deviceId: this.device.deviceId, devicePubHex: this.device.devicePubHex },
      chatId,
      sender: this.selfIdentityKey,
      participants: chat.participants,
      ts: Date.now(),
      send: { msgId, ciphertext: encrypted.ciphertext, nonce: encrypted.nonce },
    });

    this.transport.send(ClientMessage.create({ envelope: env }));

    return { chatId, msgId, ts: env.ts };
  }

  async addParticipant(chatId: string, remoteIdentity: string) {
    const msg = ClientMessage.create({ addParticipant: { chatId, remoteIdentity } });
    return this.requestWithReauth(msg, "addParticipantResponse");
  }

  async removeParticipant(chatId: string, remoteIdentity: string) {
    const msg = ClientMessage.create({ removeParticipant: { chatId, remoteIdentity } });
    return this.requestWithReauth(msg, "removeParticipantResponse");
  }

  async generateInviteLink(chatId: string, opts?: { expiresAt?: number; maxUses?: number }) {
    const msg = ClientMessage.create({
      generateInviteLink: { chatId, expiresAt: opts?.expiresAt, maxUses: opts?.maxUses },
    });
    return this.requestWithReauth(msg, "generateInviteLinkResponse");
  }

  async revokeInviteLink(chatId: string) {
    const msg = ClientMessage.create({ revokeInviteLink: { chatId } });
    return this.requestWithReauth(msg, "revokeInviteLinkResponse");
  }

  async resolveInvite(inviteCode: string) {
    const msg = ClientMessage.create({ resolveInvite: { inviteCode } });
    return this.requestWithReauth(msg, "resolveInviteResponse");
  }

  async requestJoin(inviteCode: string) {
    const msg = ClientMessage.create({ requestJoin: { inviteCode } });
    return this.requestWithReauth(msg, "requestJoinResponse");
  }

  async setChatDiscoverable(chatId: string, discoverable: boolean, category?: string) {
    const msg = ClientMessage.create({ setChatDiscoverable: { chatId, discoverable, category } });
    return this.requestWithReauth(msg, "setChatDiscoverableResponse");
  }

  async listPublicChats(category?: string) {
    const msg = ClientMessage.create({ listPublicChats: { category } });
    return this.requestWithReauth(msg, "listPublicChatsResponse");
  }

  // Fire-and-forget, mirroring evergram-client.ts's syncChats(): the server
  // replies asynchronously via one or more push-style queryChatsResponse
  // messages, processed the same way as unsolicited key-rotation broadcasts
  // (see handlePush below) — there is no single request/response pair to
  // await here in the real protocol.
  syncChats(): void {
    const knownVersions: Record<string, number> = {};
    for (const [chatId, chat] of this.chats.entries()) {
      knownVersions[chatId] = chat.chatVersion ? Number(chat.chatVersion) : 0;
    }

    this.transport.send(ClientMessage.create({ queryChats: { knownVersions } }));
  }

  getChat(chatId: string): ChatInfo | undefined {
    return this.chats.get(chatId);
  }

  // ===================== internal wire plumbing =====================

  // Registers a one-shot waiter for the next ServerMessage carrying
  // `expectedField`, without sending anything — used both by request() (which
  // sends a message first) and by anything waiting on an unsolicited push,
  // like the gateway's AuthChallenge sent right after connect.
  private waitForMessage<K extends keyof ServerMessage>(
    expectedField: K,
    timeoutMs = this.requestTimeoutMs
  ): Promise<NonNullable<ServerMessage[K]>> {
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = {
        expectedField,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.pendingRequests.indexOf(entry);
          if (idx !== -1) this.pendingRequests.splice(idx, 1);
          reject(new EvergramTimeoutError("timeout", `Timeout waiting for ${expectedField}`));
        }, timeoutMs),
      };

      this.pendingRequests.push(entry);
    });
  }

  private request<K extends keyof ServerMessage>(
    msg: ClientMessage,
    expectedField: K,
    timeoutMs = this.requestTimeoutMs
  ): Promise<NonNullable<ServerMessage[K]>> {
    const pending = this.waitForMessage(expectedField, timeoutMs);
    this.transport.send(msg);
    return pending;
  }

  // Wraps request() with a single automatic re-auth-and-retry: the gateway
  // session JWT is valid for 24h (see issueGatewaySessionJwt), and a
  // long-lived bot connection can outlive that without ever disconnecting.
  // Rather than make every bot author handle NOT_AUTHENTICATED/
  // invalid_authorization by hand, retry once via a fresh connection.
  private async requestWithReauth<K extends keyof ServerMessage>(
    msg: ClientMessage,
    expectedField: K,
    timeoutMs = this.requestTimeoutMs
  ): Promise<NonNullable<ServerMessage[K]>> {
    try {
      return await this.request(msg, expectedField, timeoutMs);
    } catch (err) {
      if (err instanceof EvergramAuthError) {
        await this.reconnectAndAuthenticate();
        return this.request(msg, expectedField, timeoutMs);
      }
      throw err;
    }
  }

  // Can't just re-run authenticate() on the same connection: the gateway
  // pushes its AuthChallenge nonce exactly once, at connection-open (see
  // gateway/index.ts's wss.on("connection", ...)), and never re-validates a
  // connection it has already accepted (handleAuthIfNeeded short-circuits on
  // __sessionAccepted). A second authenticate() on the same socket would
  // wait forever for a nonce that's never coming. A fresh connection always
  // gets a fresh nonce, so that's the only way to actually re-authenticate.
  private async reconnectAndAuthenticate(): Promise<void> {
    this.transport.close();
    await this.connect();
  }

  private handleServerMessage(msg: ServerMessage): void {
    this.resolvePendingRequests(msg);
    this.handlePush(msg);
  }

  // A single ServerMessage can legitimately carry more than one "oneof"
  // field at once — the contract bundles e.g. addParticipantResponse with a
  // rotateChatVersionResponse in the same output (see
  // contract/contract/evergram-contract.js's handleAddParticipant), and
  // ts-proto does not enforce oneof exclusivity at runtime. Check every
  // pending waiter against this message rather than stopping at the first
  // match.
  private resolvePendingRequests(msg: ServerMessage): void {
    const resolvedTypes = new Set<keyof ServerMessage>();

    for (let i = 0; i < this.pendingRequests.length; i++) {
      const entry = this.pendingRequests[i];
      if (resolvedTypes.has(entry.expectedField)) continue;

      const value = (msg as any)[entry.expectedField];
      if (value === undefined) continue;

      resolvedTypes.add(entry.expectedField);
      this.pendingRequests.splice(i, 1);
      i--;
      clearTimeout(entry.timer);

      if (value.status && value.status.ok === false) {
        entry.reject(errorFromCode(value.status.code, value.status.message));
      } else {
        entry.resolve(value);
      }
    }

    // The wire protocol has no correlation id (see webapp's
    // _sendAndWaitResponse, which has the same limitation) — a bare error
    // not tied to any specific field is attributed to the oldest pending
    // request, best-effort.
    if (msg.error && this.pendingRequests.length > 0) {
      const entry = this.pendingRequests.shift()!;
      clearTimeout(entry.timer);
      entry.reject(errorFromCode(msg.error.code || msg.error.type, msg.error.message));
    } else if (msg.error) {
      this.emit("error", errorFromCode(msg.error.code || msg.error.type, msg.error.message));
    }
  }

  private handlePush(msg: ServerMessage): void {
    if (msg.authResponse?.access) {
      this.isRestricted = !!msg.authResponse.access.isRestricted;
    }

    const chatCandidates: ChatInfo[] = [];
    if (msg.createChatResponse?.chat) chatCandidates.push(msg.createChatResponse.chat);
    if (msg.rotateChatVersionResponse?.chat) chatCandidates.push(msg.rotateChatVersionResponse.chat);
    for (const result of msg.queryChatsResponse?.results ?? []) {
      if (result.chat) chatCandidates.push(result.chat);
    }
    for (const chat of chatCandidates) this.processChatInfo(chat);

    if (msg.envelope) this.handleEnvelope(msg.envelope);

    if (msg.reputationUpdated) {
      const wasRestricted = this.isRestricted;
      this.isRestricted = !!msg.reputationUpdated.isRestricted;
      if (this.isRestricted && !wasRestricted) {
        this.emit("restricted", msg.reputationUpdated);
      }
    }

    if (msg.joinRequestedEvent) {
      this.emit("joinRequested", msg.joinRequestedEvent);
    }
  }

  // Mirrors EvergramProvider.tsx's processChat(): derive this device's
  // symmetric key from the sealed envelope the gateway produced, cache the
  // chat, and drain any messages that arrived before the key was known.
  private processChatInfo(chat: ChatInfo): void {
    if (!chat.chatId) return;

    this.chats.set(chat.chatId, chat);

    const sealed = chat.symKeyEncrypted?.[this.selfIdentityKey]?.devices?.[this.device.deviceId];
    if (!sealed) return;

    const opened = openSealedSymKey(
      { ciphertext: sealed.ciphertext, nonce: sealed.nonce, ephemeralPubkey: sealed.ephemeralPubkey },
      this.device.devicePrivHex
    );
    if (!opened) return;

    const isRotation = this.symKeys.has(chat.chatId);
    this.symKeys.set(chat.chatId, opened);

    if (isRotation) this.emit("chatKeyRotated", { chatId: chat.chatId });

    this.drainPending(chat.chatId);
  }

  private handleEnvelope(env: Envelope): void {
    if (env.type === "SEND" && env.send) {
      this.deliverOrQueue(env);
    } else if (env.type === "TYPING") {
      this.emit("typing", { chatId: env.chatId, sender: env.sender, isTyping: !!env.typing?.isTyping });
    } else if (env.type === "DELIVERY" && env.delivery) {
      this.emit("delivery", { chatId: env.chatId, msgId: env.delivery.msgId, status: env.delivery.status });
    }
  }

  // Mirrors EvergramProvider.tsx's pendingRef/flushPendingForChat pattern:
  // an envelope can arrive before this device has derived the chat's
  // symmetric key (e.g. right after being added to a chat). Queue it and
  // decrypt once processChatInfo() makes the key available.
  private deliverOrQueue(env: Envelope): void {
    const symKey = this.symKeys.get(env.chatId);
    if (!symKey) {
      const queue = this.pendingEnvelopes.get(env.chatId) ?? [];
      queue.push(env);
      this.pendingEnvelopes.set(env.chatId, queue);
      return;
    }

    this.decryptAndEmit(env, symKey);
  }

  private drainPending(chatId: string): void {
    const pending = this.pendingEnvelopes.get(chatId);
    if (!pending?.length) return;

    this.pendingEnvelopes.delete(chatId);
    const symKey = this.symKeys.get(chatId)!;
    for (const env of pending) this.decryptAndEmit(env, symKey);
  }

  private decryptAndEmit(env: Envelope, symKey: Uint8Array): void {
    const text = decryptMessage(symKey, env.send!.nonce, env.send!.ciphertext);

    const message: EvergramChatMessage = {
      chatId: env.chatId,
      sender: env.sender,
      msgId: env.send!.msgId,
      ts: env.ts,
      text,
      content: parseMessageContent(text),
    };

    this.emit("message", message);
  }
}
