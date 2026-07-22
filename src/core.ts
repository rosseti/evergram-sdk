import os from "node:os";
import {
  ChainFamily,
  ChatInfo,
  ChatSyncResult_Status,
  ClientMessage,
  Envelope,
  JoinDeniedEvent,
  JoinRequestedEvent,
  ModerationAction,
  PendingChatRequest,
  PendingGroupInvite,
  Profile,
  RelayMessage as WireRelayMessage,
  ReputationUpdated,
  ResponseStatus,
  ServerMessage,
  VisitorRoomRequestedEvent,
  WidgetConfig,
} from "./proto/evergram.js";
import { Transport } from "./transport.js";
import { TypedEventEmitter } from "./typed-event-emitter.js";
import { EvergramWallet, signAuthChallenge } from "./wallet.js";
import { identityKey, parseIdentityKey } from "./identity.js";
import {
  decryptMessage,
  deriveDevicePubHex,
  encryptMessage,
  generateMsgId,
  hexToBytes,
  openSealedSymKey,
} from "./crypto.js";
import {
  EvergramAuthError,
  EvergramNotFoundError,
  EvergramRotationError,
  EvergramTimeoutError,
  EvergramValidationError,
  errorFromCode,
} from "./errors.js";
import { MessageContent, parseMessageContent } from "./message-content.js";
import {
  decryptTextFramePayload,
  EphemeralEditEvent,
  EphemeralModerationState,
  EphemeralReactEvent,
  EphemeralRelaySession,
  EphemeralRelayStatus,
  EphemeralRemoveEvent,
  EphemeralTextEvent,
  EphemeralTypingEvent,
} from "./ephemeral-relay-session.js";
import {
  decodeRelayPayload,
  encodeRelayPayload,
  fromWireKind,
  RelayMessageKind,
  toWireKind,
} from "./relay-message-codec.js";

// Bounds pendingEnvelopes (see deliverOrQueue) for a chat whose symmetric key
// never resolves — e.g. chat_key_unsealable below, or any other case where
// processChatInfo never runs for it. Without a cap this is an unbounded
// per-chat queue for the life of the process, which matters here precisely
// because this SDK targets long-running bot processes. Generous enough that
// it never trips during the normal brief race this queue exists for
// (envelope arrives just before the chat's key push).
const MAX_PENDING_ENVELOPES_PER_CHAT = 500;

// Bounds pendingSends (see sendMessage's rotation-required retry below) for
// a long-running bot whose DELIVERY outcome for some message never arrives
// (dropped connection mid-flight, lost event, etc.) — same rationale as
// MAX_PENDING_ENVELOPES_PER_CHAT above. Each entry is normally removed the
// moment that message's outcome is known, so this only bounds the leak
// case, not the happy path.
const MAX_PENDING_SENDS = 1000;

// Bounds seenEnvelopeKeys (see decryptAndEmit's dedup check below), which
// exists because the gateway is untrusted transport and is expected to
// redeliver/replay envelopes (reconnects, mailbox resync, etc.) — see
// context/boundaries.md's "Client: Replay protection" responsibility and
// webapp's message-key.ts, which this mirrors for the SDK's own decrypt
// path. Uncapped, this would be an unbounded per-process Set for the life
// of a long-running bot; oldest keys are evicted first once the cap is hit,
// same FIFO-ish tradeoff as MAX_PENDING_ENVELOPES_PER_CHAT above.
const MAX_SEEN_ENVELOPE_KEYS = 5000;

// Bounds originalContentTypeByMsgId (see decryptAndEmit's EDIT-retype guard
// below), which records the content `type` of every SEND this process has
// observed, keyed by msgId. Same FIFO-ish eviction as MAX_SEEN_ENVELOPE_KEYS
// above and for the same reason: an unbounded per-process Map for the life
// of a long-running bot otherwise.
const MAX_ORIGINAL_CONTENT_TYPES = 5000;

// Bounds the number of distinct chatIds pendingEnvelopes can hold at once.
// MAX_PENDING_ENVELOPES_PER_CHAT above only caps each chat's queue depth —
// it does nothing to stop a malicious/untrusted gateway (see
// context/boundaries.md) from pushing one envelope each for unlimited
// fabricated chatIds that will never resolve a key (no ChatInfo for them
// ever arrives), growing the map itself without bound. Same FIFO eviction
// as MAX_SEEN_ENVELOPE_KEYS above; a real chat this device belongs to gets
// its ChatInfo pushed promptly, well within this many distinct in-flight
// chats.
const MAX_PENDING_CHATS = 200;

// Bounds pendingChatRequests/pendingGroupInvites, both populated purely
// from gateway pushes (fromIdentity / chatId are attacker-controlled from
// the SDK's point of view). Same FIFO eviction and rationale as
// MAX_PENDING_CHATS above.
const MAX_PENDING_CHAT_REQUESTS = 500;
const MAX_PENDING_GROUP_INVITES = 500;

// Mirrors the OS family naming the webapp's platform-label.ts already uses
// for the "{Browser} · {OS}" convention (Preferences > Devices), so the
// device owner sees a consistent OS name regardless of which client
// connected. os.platform() has more values than this (freebsd, sunos,
// aix, ...) — those are rare enough for a bot host that the raw Node value
// is left as-is rather than guessing a display name for them.
function osFamily(): string {
  switch (os.platform()) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return os.platform();
  }
}

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
  /**
   * Self-declared platform/client label shown in the device owner's
   * Preferences > Devices list (Baileys-style, e.g. `Browsers.ubuntu`) —
   * the gateway never infers this from a User-Agent for bot connections.
   * Defaults to `"Terminal · " + osFamily()` (e.g. "Terminal · Linux"),
   * auto-detected via Node's `os.platform()` — see osFamily() below.
   */
  platform?: string;
  /** Mirrors the contract's EVERGRAM_MAX_PARTICIPANTS (default 100). */
  maxParticipants?: number;
  /**
   * Mirrors the gateway's NEXT_PUBLIC_MAX_MESSAGE_SIZE. Unset by default —
   * the SDK has no way to know your deployment's configured value, so
   * client-side validation is skipped unless you provide it. The server
   * enforces this regardless; this option only saves a round-trip.
   */
  maxMessageSize?: number;
  /** Per-request timeout in ms. Default 30000. */
  requestTimeoutMs?: number;
  /**
   * Internal — lets tests inject a fake Transport instead of mocking the
   * whole module. Not needed for normal bot usage; omit it and EvergramCore
   * builds its own Transport(opts.url).
   */
  transport?: Transport;
}

interface PendingRequest {
  expectedField: keyof ServerMessage;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  // Disambiguates concurrent same-type calls (e.g. two getProfile() calls
  // in flight at once) — some responses already echo back enough of the
  // request to match on, same idea as webapp's _sendAndWaitResponse
  // `matcher` param. Now a fallback (see requestId below): kept for calls
  // against a gateway that predates request_id, and for responses that
  // genuinely carry no echoed field.
  matcher?: (value: any) => boolean;
  // Client-generated correlation id, echoed back by the gateway on the
  // matching response (see ClientMessage.request_id in the proto) —
  // resolvePendingRequests() checks this before any type/matcher-based
  // guessing. Undefined for waiters with nothing sent on the wire (e.g. the
  // authChallenge push-wait, which isn't a response to any request()).
  requestId?: number;
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

export interface EvergramReaction {
  chatId: string;
  sender: string;
  msgId: string;
  /** The decrypted emoji, or null when removed (or undecryptable). */
  emoji: string | null;
  removed: boolean;
  ts: number;
}

export interface EvergramMessageEdited {
  chatId: string;
  sender: string;
  msgId: string;
  text: string | null;
  /** Typed view of `text`, same as EvergramChatMessage.content. */
  content: MessageContent;
  editedAt: number;
}

export interface EvergramMessageDeleted {
  chatId: string;
  sender: string;
  msgId: string;
  removedAt: number;
}

// Widget-visitor chat — see [[evergram-sdk-relay-duplication]] memory.
// roomToken (not chatId) is the correlation key here: these conversations
// are never contract-backed chats, just an ephemeral gateway relay (see
// ephemeral-relay-session.ts).
export interface EvergramVisitorMessage extends EphemeralTextEvent {
  roomToken: string;
}

export interface EvergramVisitorReaction extends EphemeralReactEvent {
  roomToken: string;
}

export interface EvergramVisitorMessageEdited extends EphemeralEditEvent {
  roomToken: string;
}

export interface EvergramVisitorMessageDeleted extends EphemeralRemoveEvent {
  roomToken: string;
}

export interface EvergramVisitorTyping extends EphemeralTypingEvent {
  roomToken: string;
}

export interface EvergramVisitorRoomRequested {
  roomToken: string;
  widgetId: string;
  visitorLabel: string;
  origin: string;
  ts: number;
  /** Null only if the bundled first message failed to decrypt — see handleVisitorRoomRequestedEvent. */
  firstMessage: EphemeralTextEvent | null;
  /**
   * This device's own copy of the room's symmetric key, already unsealed —
   * not a secret being newly exposed, just the same key this process needed
   * to decrypt `firstMessage` above. Handed out so a long-running bot can
   * persist {roomToken, symKey, widgetId, visitorLabel, origin} itself and
   * call registerVisitorSession() with it after a restart — there is no
   * contract/gateway-side record of active rooms to recover this from
   * otherwise (see registerVisitorSession's doc comment).
   */
  symKey: Uint8Array;
}

export interface EvergramVisitorStatusChanged {
  roomToken: string;
  status: EphemeralRelayStatus;
  /** Only set alongside status "peer_left" — see EphemeralStatusMeta. */
  peerLeftDeadline?: number;
}

export interface EvergramVisitorRoomTimedOut {
  roomToken: string;
}

// public_group only — a live roster event for a subscribed channel, fired
// via RELAY_CHANNEL_JOIN/RELAY_CHANNEL_PART. See subscribePublicChannel.
export interface EvergramVisitorChannelParticipantJoined {
  roomToken: string;
  sender: string;
  /** Set on a mid-session nickname change, not a fresh join. */
  previousSender?: string;
}

export interface EvergramVisitorChannelParticipantLeft {
  roomToken: string;
  sender: string;
}

// public_group only — fires whenever a moderateChannel() action (by this
// bot or another op) changes the channel's moderated flag or op/voice
// roster (RELAY_CHANNEL_MODE).
export interface EvergramVisitorChannelModeChanged extends EphemeralModerationState {
  roomToken: string;
}

// public_group only — fires when this bot's own subscription was kicked or
// banned from the channel (RELAY_CHANNEL_KICKED). The session is torn down
// (see createVisitorSession's onStatusChange) right after this fires.
export interface EvergramVisitorKicked {
  roomToken: string;
  reason: "kicked" | "banned";
}

// Payload types for every event EvergramCore emits — see TypedEventEmitter.
// Replaces what used to be a prose comment listing event name -> payload;
// now `core.on("mesage", ...)` (typo) or `core.emit("connected", 123)`
// (wrong payload) are compile errors instead of silent no-ops.
export interface EvergramCoreEvents {
  connected: [];
  authenticated: [];
  disconnected: [];
  reconnecting: [attempt: number];
  error: [err: Error];
  message: [msg: EvergramChatMessage];
  reaction: [reaction: EvergramReaction];
  messageEdited: [edit: EvergramMessageEdited];
  messageDeleted: [deletion: EvergramMessageDeleted];
  typing: [event: { chatId: string; sender: string; isTyping: boolean }];
  delivery: [
    event: { chatId: string; msgId: string; status: ResponseStatus | undefined; eventType: string },
  ];
  chatKeyRotated: [event: { chatId: string }];
  chatRemoved: [chatId: string];
  joinRequested: [event: JoinRequestedEvent];
  joinDenied: [event: JoinDeniedEvent];
  chatRequestReceived: [event: PendingChatRequest];
  groupInviteReceived: [event: PendingGroupInvite];
  restricted: [event: ReputationUpdated];
  visitorRoomRequested: [event: EvergramVisitorRoomRequested];
  visitorMessage: [event: EvergramVisitorMessage];
  visitorReaction: [event: EvergramVisitorReaction];
  visitorMessageEdited: [event: EvergramVisitorMessageEdited];
  visitorMessageDeleted: [event: EvergramVisitorMessageDeleted];
  visitorTyping: [event: EvergramVisitorTyping];
  visitorStatusChanged: [event: EvergramVisitorStatusChanged];
  visitorRoomTimedOut: [event: EvergramVisitorRoomTimedOut];
  visitorChannelParticipantJoined: [event: EvergramVisitorChannelParticipantJoined];
  visitorChannelParticipantLeft: [event: EvergramVisitorChannelParticipantLeft];
  visitorChannelModeChanged: [event: EvergramVisitorChannelModeChanged];
  visitorKicked: [event: EvergramVisitorKicked];
}

// Low-level, faithful mirror of the wire protocol — modeled on the webapp
// client's own browser equivalent. EvergramBot (bot.ts) wraps
// this with an ergonomic API; use Core directly when you need control over
// the raw protocol (e.g. a non-chat integration). See EvergramCoreEvents
// above for every event this class emits and its payload type.
export class EvergramCore extends TypedEventEmitter<EvergramCoreEvents> {
  private readonly transport: Transport;
  private readonly wallet: EvergramWallet;
  private readonly device: EvergramDevice;
  private readonly platformLabel: string;
  private readonly identity = { chainFamily: ChainFamily.XRPL, address: "" } as {
    chainFamily: ChainFamily;
    address: string;
  };
  private readonly selfIdentityKey: string;
  private readonly maxParticipants: number;
  private readonly maxMessageSize?: number;
  private readonly requestTimeoutMs: number;

  private readonly pendingRequests: PendingRequest[] = [];
  // O(1) lookup for the common case (both sides support request_id) —
  // pendingRequests remains the source of truth for entries and still
  // backs the type/matcher fallback below.
  private readonly pendingByRequestId = new Map<number, PendingRequest>();
  // uint32 on the wire; wraps back to 1 rather than 0 ("unset") on overflow.
  // A long-lived bot connection issuing one request/ms would still take
  // ~50 days to wrap, long past any single request's timeout window.
  private nextRequestId = 1;
  private readonly chats = new Map<string, ChatInfo>();
  private readonly symKeys = new Map<string, Uint8Array>();
  private readonly pendingEnvelopes = new Map<string, Envelope[]>();
  // Insertion-ordered dedup set for decryptAndEmit — see
  // MAX_SEEN_ENVELOPE_KEYS above. A Map (not Set) so eviction can reuse
  // Map's insertion-order iteration to drop the oldest key in O(1).
  private readonly seenEnvelopeKeys = new Map<string, true>();
  // Records the content `type` of every SEND this process has decrypted,
  // keyed by msgId — lets decryptAndEmit's EDIT branch reject an incoming
  // edit that retypes a message (e.g. text -> payment_request) instead of
  // trusting whatever type the EDIT envelope carries. See
  // MAX_ORIGINAL_CONTENT_TYPES above.
  private readonly originalContentTypeByMsgId = new Map<string, MessageContent["type"]>();
  // Tracks in-flight sendMessage() calls by their own msgId so a later
  // ROTATION_REQUIRED delivery failure can rotate the chat key and resend
  // the original plaintext — see handleEnvelope's DELIVERY branch and
  // retrySendOnRotationRequired(). Removed as soon as that msgId's outcome
  // (success, non-rotation failure, or retry exhausted) is known.
  private readonly pendingSends = new Map<
    string,
    { chatId: string; text: string; opts?: { replyToMsgId?: string }; retried: boolean }
  >();
  private readonly pendingChatRequests = new Map<string, PendingChatRequest>();
  private readonly pendingGroupInvites = new Map<string, PendingGroupInvite>();
  // Dedicated signal for connect()/reconnectAndAuthenticate() to observe an
  // auth failure during their own connection attempt, without racing the
  // public "error" event — which is also emitted for unrelated background
  // failures (rotation-retry exhaustion, visitor-session resync, etc.) that
  // must not spuriously reject an in-flight connect(). See notifyConnectFailure().
  private readonly connectFailureListeners = new Set<(err: Error) => void>();
  // Live widget-visitor relay sessions this process is currently a party
  // to, keyed by roomToken — see [[evergram-sdk-relay-duplication]]. Not a
  // separate registry file (unlike the webapp's visitor-session-registry.ts,
  // which exists specifically to survive React re-renders); a plain field
  // here is equivalent to how `chats`/`symKeys` already work.
  private readonly visitorSessions = new Map<
    string,
    {
      session: EphemeralRelaySession;
      widgetId: string;
      visitorLabel: string;
      origin: string;
      // public_group only — set for sessions created via subscribePublicChannel,
      // not the 1:1 VisitorRoomRequestedEvent path. channelKeyHex is kept so
      // resyncVisitorSessions can re-call subscribePublicChannel (not just
      // resend "joined" — see its comment) after a reconnect.
      isChannel?: boolean;
      channelKeyHex?: string;
      // public_group only — the sender name last passed to
      // announceChannelPresence for this session, so resyncVisitorSessions
      // can re-announce it after a reconnect (see its comment) instead of
      // silently dropping this bot's own roster entry.
      lastAnnouncedSender?: string;
    }
  >();

  private authenticated = false;
  isRestricted = false;
  // Populated from the same authResponse connect()/authenticate() already
  // wait on — "complete"/"missing_nickname", set server-side. Lets
  // EvergramBot.start() skip a redundant
  // setProfile() round trip when the desired nickname is already set,
  // instead of unconditionally re-applying it on every start/reconnect.
  profile?: Profile;
  profileStatus?: string;

  constructor(opts: EvergramCoreOptions) {
    super();

    this.wallet = opts.wallet;
    this.device = opts.device;
    this.platformLabel = opts.platform || `Terminal · ${osFamily()}`;
    this.assertDeviceKeypairValid(opts.device);
    this.identity.address = opts.wallet.address;
    this.selfIdentityKey = identityKey(this.identity as any);
    this.maxParticipants = opts.maxParticipants ?? 100;
    this.maxMessageSize = opts.maxMessageSize;
    // Must clear the gateway's own per-attempt consensus-wait timeout with
    // margin — otherwise the client gives up before the gateway itself
    // would even call the request a failure, orphaning a write that's
    // still in flight server-side.
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;

    this.transport = opts.transport ?? new Transport(opts.url);

    this.transport.onOpen(() => {
      this.emit("connected");
      this.authenticate()
        .then(() => {
          this.authenticated = true;
          // Mirrors the webapp client, which does the same right after auth
          // (its own auth-ready/syncChats call before going fully online).
          // Without this, a fresh process —
          // or even a reconnect — has an empty `chats`/`symKeys` map and
          // silently swallows envelopes for any chat that existed before
          // this connection, since nothing else ever re-populates them.
          this.syncChats();
          this.resyncVisitorSessions();
          this.emit("authenticated");
        })
        .catch((err) => {
          this.emit("error", err);
          this.notifyConnectFailure(err);
        });
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
      const onConnectFailure = (err: Error) => {
        cleanup();
        reject(err);
      };
      // Node's EventEmitter throws synchronously on emit("error", ...) if
      // zero "error" listeners are registered. connectFailureListeners
      // (above) is our own signal for connect()'s promise settlement and is
      // NOT a real EventEmitter listener, so it doesn't make emit("error")
      // safe on its own. Register a real no-op listener for the duration of
      // this connect() attempt so any emit("error", ...) triggered by the
      // auth flow (see transport.onOpen's .catch above) can't throw and
      // crash the process. connect()'s settlement still only reacts to
      // notifyConnectFailure, not to this listener, so unrelated background
      // emit("error", ...) calls still can't spuriously reject connect().
      const onErrorNoop = () => {};
      const cleanup = () => {
        this.off("authenticated", onAuthenticated);
        this.off("error", onErrorNoop);
        this.connectFailureListeners.delete(onConnectFailure);
      };

      this.once("authenticated", onAuthenticated);
      this.on("error", onErrorNoop);
      this.connectFailureListeners.add(onConnectFailure);

      this.transport.connect().catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  // Notifies only listeners registered by an in-flight connect() call — see
  // connectFailureListeners above. Does not affect the public "error" event.
  private notifyConnectFailure(err: Error): void {
    for (const cb of this.connectFailureListeners) cb(err);
  }

  close(): void {
    this.transport.close();
  }

  // Self-heals a brand-new bot identity's first connection: the gateway
  // accepts the WebSocket session as soon as the wallet signature checks
  // out, but the *contract* separately rejects authResponse with
  // device_not_registered until registerDevice has run — confirmed
  // empirically against the local
  // gateway. Register once and retry rather than making every bot author
  // special-case this on first run.
  private async authenticate(): Promise<void> {
    const challenge = await this.waitForMessage("authChallenge");
    const proof = signAuthChallenge(this.wallet, this.device.deviceId, challenge.nonce);

    const msg = ClientMessage.create({
      auth: {
        identity: this.identity,
        proof: { signedMessage: proof },
        device: {
          deviceId: this.device.deviceId,
          devicePubHex: this.device.devicePubHex,
          platform: this.platformLabel,
        },
      },
    });

    try {
      await this.request(msg, "authResponse");
    } catch (err) {
      if (err instanceof EvergramNotFoundError && err.code === "device_not_registered") {
        const registerMsg = ClientMessage.create({
          registerDevice: {
            identity: this.identity,
            device: {
              deviceId: this.device.deviceId,
              devicePubHex: this.device.devicePubHex,
              platform: this.platformLabel,
            },
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
        device: {
          deviceId: this.device.deviceId,
          devicePubHex: this.device.devicePubHex,
          platform: this.platformLabel,
        },
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

    // changeProfileResponse echoes the full (merged) profile, so a call that
    // specified a given field can match on that field's requested value —
    // disambiguates concurrent setProfile() calls with different values.
    // Two concurrent calls setting the *same* value are inherently
    // indistinguishable this way, but then it doesn't matter which resolves
    // which, since the outcome is identical either way.
    const resp = await this.requestWithReauth(
      msg,
      "changeProfileResponse",
      undefined,
      (v) =>
        !!v.profile &&
        (opts.nickname === undefined || v.profile.nickname === opts.nickname) &&
        (opts.avatarUrl === undefined || v.profile.avatarUrl === opts.avatarUrl) &&
        (opts.bio === undefined || v.profile.bio === opts.bio),
    );
    // Without this, this.profile stays whatever authResponse handed back at
    // connect time — sendVisitorMessage's `sender ?? this.profile?.nickname`
    // default (and any other caller reading this.profile) would keep echoing
    // the pre-rename nickname for the rest of the session.
    if (resp.profile) this.profile = resp.profile;
    return resp;
  }

  async createChat(type: "one-on-one" | "group", participants: string[], meta?: any) {
    if (participants.length > this.maxParticipants) {
      throw new EvergramValidationError(
        "too_many_participants",
        `${participants.length} participants exceeds the configured limit of ${this.maxParticipants}`,
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

    // createChatResponse's chat.chatId is server-generated and unknown
    // in advance, so it can't seed a matcher the way an already-known
    // chatId does elsewhere — but the contract does echo back the
    // resulting chat.participants, which for concurrent createChat() calls
    // aimed at different people will very rarely coincide. Best-effort,
    // like acceptChatRequest()'s participants match above.
    const resp = await this.requestWithReauth(
      msg,
      "createChatResponse",
      undefined,
      (v) => !!v.chat && participants.some((p) => v.chat!.participants?.includes(p)),
    );
    // handlePush() already calls processChatInfo() for the same chat when
    // the push arrives, synchronously before this await resolves — calling
    // it again here double-processes it and, since symKeys is already
    // populated by then, makes processChatInfo()'s isRotation check
    // wrongly fire a spurious chatKeyRotated event. See rotateChatVersion().
    return resp;
  }

  // Opt-in privacy gate: when the recipient has requireChatApproval set,
  // createChat() above returns status.code "pending_approval" (no chat) and
  // queues a PendingChatRequest server-side instead. The recipient accepts
  // it here, mirroring createChat()'s key-exchange — the gateway resolves
  // device public keys and seals the symKey, the same as for a fresh chat.
  async acceptChatRequest(fromIdentity: string) {
    const msg = ClientMessage.create({ acceptChatRequest: { fromIdentity } });

    // No field on AcceptChatRequestResponse echoes fromIdentity directly,
    // but each pending request is for a distinct chat, so the resulting
    // chat's participants disambiguate concurrent accepts the same way a
    // chatId match would.
    const resp = await this.requestWithReauth(
      msg,
      "acceptChatRequestResponse",
      undefined,
      (v) => !!v.chat?.participants?.includes(fromIdentity),
    );
    this.pendingChatRequests.delete(fromIdentity);
    // handlePush() already applies resp.chat via processChatInfo() before
    // this await resolves — see createChat() above for why calling it again
    // here would spuriously fire chatKeyRotated.
    return resp;
  }

  // Identity-indexed, not chat-indexed: also rejects a pending chat request
  // from `targetIdentity` (no chat is ever created), and is enforced by the
  // gateway on message delivery for chats that were already accepted.
  async blockIdentity(targetIdentity: string) {
    const msg = ClientMessage.create({ blockIdentity: { targetIdentity } });
    const resp = await this.requestWithReauth(
      msg,
      "blockIdentityResponse",
      undefined,
      (v) => v.targetIdentity === targetIdentity,
    );
    this.pendingChatRequests.delete(targetIdentity);
    return resp;
  }

  async unblockIdentity(targetIdentity: string) {
    const msg = ClientMessage.create({ unblockIdentity: { targetIdentity } });
    return this.requestWithReauth(
      msg,
      "unblockIdentityResponse",
      undefined,
      (v) => v.targetIdentity === targetIdentity,
    );
  }

  async updatePrivacySettings(requireChatApproval: boolean) {
    const msg = ClientMessage.create({ updatePrivacySettings: { requireChatApproval } });
    // On success settings.requireChatApproval reflects the value just set,
    // so it doubles as this call's own echo — same disambiguation the
    // explicit-field calls above use.
    return this.requestWithReauth(
      msg,
      "updatePrivacySettingsResponse",
      undefined,
      (v) => v.settings?.requireChatApproval === requireChatApproval,
    );
  }

  getPendingChatRequests(): PendingChatRequest[] {
    return Array.from(this.pendingChatRequests.values());
  }

  // Group equivalent: addParticipant() below defers to a PendingGroupInvite
  // (keyed by chatId, not by inviter — the same admin can invite this
  // identity to several groups) when requireChatApproval is set. The
  // gateway re-derives symKeyEncrypted fresh at accept time rather than
  // reusing whatever was sealed when the invite was created, since the
  // chat's key may have rotated again in the meantime.
  async acceptGroupInvite(chatId: string) {
    const msg = ClientMessage.create({ acceptGroupInvite: { chatId } });
    const resp = await this.requestWithReauth(
      msg,
      "acceptGroupInviteResponse",
      undefined,
      (v) => v.chatId === chatId,
    );
    this.pendingGroupInvites.delete(chatId);
    return resp;
  }

  // Declines this one invite only — does not block the inviter (use
  // blockIdentity separately for that).
  async declineGroupInvite(chatId: string) {
    const msg = ClientMessage.create({ declineGroupInvite: { chatId } });
    const resp = await this.requestWithReauth(
      msg,
      "declineGroupInviteResponse",
      undefined,
      (v) => v.chatId === chatId,
    );
    this.pendingGroupInvites.delete(chatId);
    return resp;
  }

  getPendingGroupInvites(): PendingGroupInvite[] {
    return Array.from(this.pendingGroupInvites.values());
  }

  async sendMessage(chatId: string, text: string, opts?: { replyToMsgId?: string }) {
    if (this.maxMessageSize !== undefined) {
      const byteLength = Buffer.byteLength(text, "utf8");
      if (byteLength > this.maxMessageSize) {
        throw new EvergramValidationError(
          "message_too_large",
          `Message is ${byteLength} bytes, exceeding the configured limit of ${this.maxMessageSize}`,
        );
      }
    }

    const symKey = this.symKeys.get(chatId);
    if (!symKey) {
      throw new EvergramNotFoundError(
        "chat_key_unknown",
        `No symmetric key known for chat ${chatId} yet — call syncChats() or wait for the chat to be established`,
      );
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
      send: {
        msgId,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        replyToMsgId: opts?.replyToMsgId || "",
      },
    });

    this.transport.send(ClientMessage.create({ envelope: env }));

    this.trackPendingSend(msgId, chatId, text, opts);

    return { chatId, msgId, ts: env.ts };
  }

  private trackPendingSend(
    msgId: string,
    chatId: string,
    text: string,
    opts?: { replyToMsgId?: string },
    retried = false,
  ): void {
    if (this.pendingSends.size >= MAX_PENDING_SENDS) {
      const oldest = this.pendingSends.keys().next().value;
      if (oldest !== undefined) this.pendingSends.delete(oldest);
    }

    this.pendingSends.set(msgId, { chatId, text, opts, retried });
  }

  // Bounded to a single retry (maxRotationRetries = 1, same convention as
  // the webapp client — see the device-revocation design doc's protocol
  // invariants): rotate the chat's key once, then resend the original
  // plaintext once under the new key. A second ROTATION_REQUIRED after that
  // surfaces as a normal "delivery" failure plus an "error" event instead
  // of looping. Returns true if this delivery outcome was swallowed
  // (because a retry is in flight, or has just been finalized as an error
  // here) — false means "not ours, let the normal delivery event through".
  //
  // Note: the resend gets a brand-new msgId (generateMsgId() inside
  // sendMessage) — there's no way to resend under the original msgId since
  // the message is being re-encrypted under a different chat key. A bot
  // author tracking delivery by the msgId sendMessage() first returned will
  // not see a later success event for it; they will see the original
  // msgId's eventual failure if the single retry is also rejected.
  private retrySendOnRotationRequired(msgId: string): boolean {
    const pending = this.pendingSends.get(msgId);
    if (!pending) return false;

    this.pendingSends.delete(msgId);

    if (pending.retried) {
      const err = new EvergramRotationError(
        "rotation_required",
        `Message ${msgId} could not be delivered after one rotate-and-retry attempt`,
      );
      this.emit("error", err);
      this.emit("delivery", {
        chatId: pending.chatId,
        msgId,
        status: { ok: false, code: "ROTATION_REQUIRED", message: err.message },
        eventType: "SEND",
      });
      return true;
    }

    (async () => {
      try {
        await this.rotateChatVersion(pending.chatId);
        const resent = await this.sendMessage(pending.chatId, pending.text, pending.opts);
        const resentEntry = this.pendingSends.get(resent.msgId);
        if (resentEntry) resentEntry.retried = true;
      } catch (err) {
        const evergramErr =
          err instanceof Error ? err : new EvergramRotationError("rotation_required", String(err));
        this.emit("error", evergramErr);
        this.emit("delivery", {
          chatId: pending.chatId,
          msgId,
          status: { ok: false, code: "ROTATION_REQUIRED", message: evergramErr.message },
          eventType: "SEND",
        });
      }
    })();

    return true;
  }

  // Fire-and-forget, like sendMessage above — no encryption (typing state
  // isn't message content) and no debounce/auto-clear timer: the webapp adds
  // a 3s auto-clear because it's driven by raw keystroke events in a
  // browser, a UI affordance rather than a protocol requirement. The gateway
  // also rate-limits isTyping:true to 1 per 2s per identity+device and
  // silently drops excess (see README "Rate limits") — call this at most
  // that often if you want every call to actually reach the other side.
  sendTyping(chatId: string, isTyping: boolean): void {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new EvergramNotFoundError("chat_not_found", `Unknown chat ${chatId}`);
    }

    const env = Envelope.create({
      type: "TYPING",
      device: { deviceId: this.device.deviceId, devicePubHex: this.device.devicePubHex },
      chatId,
      sender: this.selfIdentityKey,
      participants: chat.participants,
      ts: Date.now(),
      typing: { isTyping },
    });

    this.transport.send(ClientMessage.create({ envelope: env }));
  }

  async reactToMessage(chatId: string, msgId: string, emoji: string) {
    const symKey = this.getSymKeyOrThrow(chatId);
    const chat = this.getChatOrThrow(chatId);
    const encrypted = encryptMessage(symKey, emoji);

    const env = Envelope.create({
      type: "REACT",
      device: { deviceId: this.device.deviceId, devicePubHex: this.device.devicePubHex },
      chatId,
      sender: this.selfIdentityKey,
      participants: chat.participants,
      ts: Date.now(),
      react: { msgId, ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, removed: false },
    });

    this.transport.send(ClientMessage.create({ envelope: env }));

    return { chatId, msgId, ts: env.ts };
  }

  async removeReaction(chatId: string, msgId: string) {
    const chat = this.getChatOrThrow(chatId);

    const env = Envelope.create({
      type: "REACT",
      device: { deviceId: this.device.deviceId, devicePubHex: this.device.devicePubHex },
      chatId,
      sender: this.selfIdentityKey,
      participants: chat.participants,
      ts: Date.now(),
      react: { msgId, ciphertext: "", nonce: "", removed: true },
    });

    this.transport.send(ClientMessage.create({ envelope: env }));

    return { chatId, msgId, ts: env.ts };
  }

  // Only text messages may be edited — the gateway enforces the 15-minute
  // edit window but has no way to know the original message's content type,
  // since it never decrypts
  // anything. Restricting this client-side prevents e.g. silently rewriting
  // a payment_request's amount after the fact; recipients independently
  // re-check the original content type before applying an incoming edit.
  async editMessage(chatId: string, msgId: string, newText: string) {
    if (this.maxMessageSize !== undefined) {
      const byteLength = Buffer.byteLength(newText, "utf8");
      if (byteLength > this.maxMessageSize) {
        throw new EvergramValidationError(
          "message_too_large",
          `Message is ${byteLength} bytes, exceeding the configured limit of ${this.maxMessageSize}`,
        );
      }
    }

    const symKey = this.getSymKeyOrThrow(chatId);
    const chat = this.getChatOrThrow(chatId);
    const encrypted = encryptMessage(symKey, newText);

    const env = Envelope.create({
      type: "EDIT",
      device: { deviceId: this.device.deviceId, devicePubHex: this.device.devicePubHex },
      chatId,
      sender: this.selfIdentityKey,
      participants: chat.participants,
      ts: Date.now(),
      edit: {
        msgId,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        editedAt: Date.now(),
        removed: false,
      },
    });

    this.transport.send(ClientMessage.create({ envelope: env }));

    return { chatId, msgId, ts: env.ts };
  }

  // "Delete for everyone" — same wire envelope as editMessage, with
  // removed=true and no ciphertext. Subject to the same 15-minute window;
  // after it expires, only a local-only "delete for me" makes sense, which
  // is purely client-side state and out of scope for this SDK (it never
  // persists chat history for you in the first place).
  async deleteMessage(chatId: string, msgId: string) {
    const chat = this.getChatOrThrow(chatId);

    const env = Envelope.create({
      type: "EDIT",
      device: { deviceId: this.device.deviceId, devicePubHex: this.device.devicePubHex },
      chatId,
      sender: this.selfIdentityKey,
      participants: chat.participants,
      ts: Date.now(),
      edit: { msgId, ciphertext: "", nonce: "", editedAt: Date.now(), removed: true },
    });

    this.transport.send(ClientMessage.create({ envelope: env }));

    return { chatId, msgId, ts: env.ts };
  }

  async addParticipant(chatId: string, remoteIdentity: string) {
    const msg = ClientMessage.create({ addParticipant: { chatId, remoteIdentity } });
    return this.requestWithReauth(
      msg,
      "addParticipantResponse",
      undefined,
      (v) => v.chatId === chatId && v.remoteIdentity === remoteIdentity,
    );
  }

  async removeParticipant(chatId: string, remoteIdentity: string) {
    const msg = ClientMessage.create({ removeParticipant: { chatId, remoteIdentity } });
    return this.requestWithReauth(
      msg,
      "removeParticipantResponse",
      undefined,
      (v) => v.chatId === chatId && v.remoteIdentity === remoteIdentity,
    );
  }

  // Rejected by the contract for one-on-one chats (leave_not_allowed) — group
  // chats only. The contract bundles a rotateChatVersionResponse with the
  // updated ChatInfo (participants minus this identity) alongside
  // leaveChatResponse; handlePush()/processChatInfo() below already apply
  // that for both the leaver and every remaining participant, so no extra
  // local cleanup is needed here.
  async leaveChat(chatId: string) {
    const msg = ClientMessage.create({ leaveChat: { chatId } });
    return this.requestWithReauth(msg, "leaveChatResponse", undefined, (v) => v.chatId === chatId);
  }

  // The gateway does the actual key generation/wrapping server-side (it
  // reads current participants + chatVersion fresh, generates a symKey, and
  // seals it per device's public key) — the SDK only needs to
  // ask for it. processChatInfo() (via handlePush) updates this.symKeys
  // from the resulting rotateChatVersionResponse before this call resolves.
  async rotateChatVersion(chatId: string) {
    const msg = ClientMessage.create({ rotateChatVersion: { chatId } });
    return this.requestWithReauth(
      msg,
      "rotateChatVersionResponse",
      undefined,
      (v) => v.chat?.chatId === chatId,
    );
  }

  async getProfile(remoteIdentity: string) {
    const parsed = parseIdentityKey(remoteIdentity);
    const msg = ClientMessage.create({ getProfile: { remoteIdentity: parsed } });
    // getProfileResponse echoes remote_identity precisely so concurrent
    // getProfile() calls for different identities can't cross-resolve
    // each other (see resolvePendingRequests).
    const resp = await this.requestWithReauth(
      msg,
      "getProfileResponse",
      undefined,
      (v) => v.remoteIdentity?.address === parsed.address,
    );
    return resp.profile;
  }

  async reportUser(targetIdentity: string, reason: string) {
    const msg = ClientMessage.create({ reportUser: { targetIdentity, reason } });
    return this.requestWithReauth(
      msg,
      "reportUserResponse",
      undefined,
      (v) => v.targetIdentity === targetIdentity,
    );
  }

  async setChatMode(chatId: string, opts: { moderated: boolean }) {
    const msg = ClientMessage.create({ setChatMode: { chatId, moderated: opts.moderated } });
    return this.requestWithReauth(
      msg,
      "setChatModeResponse",
      undefined,
      (v) => v.chatId === chatId,
    );
  }

  // Replaces the chat's full admin/moderator lists — not a delta. Read
  // getChat(chatId)?.meta?.roles first if you need to add/remove just one
  // identity. Same rotateChatVersionResponse bundling as leaveChat() above —
  // role changes propagate to other participants with no extra code here.
  async updateChatRoles(chatId: string, roles: { admins: string[]; moderators: string[] }) {
    const msg = ClientMessage.create({
      updateChatRoles: { chatId, admins: roles.admins, moderators: roles.moderators },
    });
    return this.requestWithReauth(
      msg,
      "updateChatRolesResponse",
      undefined,
      (v) => v.chatId === chatId,
    );
  }

  async generateInviteLink(chatId: string, opts?: { expiresAt?: number; maxUses?: number }) {
    const msg = ClientMessage.create({
      generateInviteLink: { chatId, expiresAt: opts?.expiresAt, maxUses: opts?.maxUses },
    });
    return this.requestWithReauth(
      msg,
      "generateInviteLinkResponse",
      undefined,
      (v) => v.chatId === chatId,
    );
  }

  async revokeInviteLink(chatId: string) {
    const msg = ClientMessage.create({ revokeInviteLink: { chatId } });
    return this.requestWithReauth(
      msg,
      "revokeInviteLinkResponse",
      undefined,
      (v) => v.chatId === chatId,
    );
  }

  async resolveInvite(inviteCode: string) {
    const msg = ClientMessage.create({ resolveInvite: { inviteCode } });
    return this.requestWithReauth(
      msg,
      "resolveInviteResponse",
      undefined,
      (v) => v.inviteCode === inviteCode,
    );
  }

  async requestJoin(inviteCode: string) {
    const msg = ClientMessage.create({ requestJoin: { inviteCode } });
    return this.requestWithReauth(
      msg,
      "requestJoinResponse",
      undefined,
      (v) => v.inviteCode === inviteCode,
    );
  }

  async denyJoinRequest(chatId: string, remoteIdentity: string) {
    const msg = ClientMessage.create({ denyJoinRequest: { chatId, remoteIdentity } });
    return this.requestWithReauth(msg, "denyJoinResponse", undefined, (v) => v.chatId === chatId);
  }

  async setChatDiscoverable(chatId: string, discoverable: boolean, category?: string) {
    const msg = ClientMessage.create({ setChatDiscoverable: { chatId, discoverable, category } });
    return this.requestWithReauth(
      msg,
      "setChatDiscoverableResponse",
      undefined,
      (v) => v.chatId === chatId,
    );
  }

  async listPublicChats(category?: string) {
    const msg = ClientMessage.create({ listPublicChats: { category } });
    return this.requestWithReauth(
      msg,
      "listPublicChatsResponse",
      undefined,
      (v) => (v.category || undefined) === category,
    );
  }

  // Fire-and-forget, mirroring evergram-client.ts's syncChats(): the server
  // replies asynchronously via one or more push-style queryChatsResponse
  // messages, processed the same way as unsolicited key-rotation broadcasts
  // (see handlePush below) — there is no single request/response pair to
  // await here in the real protocol.
  syncChats(): void {
    const knownVersions: Record<string, number> = {};
    const knownMetaVersions: Record<string, number> = {};
    for (const [chatId, chat] of this.chats.entries()) {
      // Both fallbacks match the contract's own defaults (chatVersion || 1,
      // metaVersion || 1) so a chat with no locally-tracked version sits at
      // the server's actual baseline of 1, never 0. In practice
      // `this.chats` is in-memory only
      // (never persisted across restarts) and only ever populated from real
      // server ChatInfo payloads, so these fallbacks are structurally
      // unreachable today — kept for defensive consistency, not because
      // either branch currently fires.
      knownVersions[chatId] = chat.chatVersion ? Number(chat.chatVersion) : 1;
      knownMetaVersions[chatId] = chat.metaVersion ? Number(chat.metaVersion) : 1;
    }

    this.transport.send(ClientMessage.create({ queryChats: { knownVersions, knownMetaVersions } }));
  }

  getChat(chatId: string): ChatInfo | undefined {
    return this.chats.get(chatId);
  }

  // ===================== widget-visitor chat =====================
  // See [[evergram-sdk-relay-duplication]] memory — ported from the
  // webapp's widget feature, kept in sync manually rather than shared.

  async createWidget(name: string) {
    const msg = ClientMessage.create({ createWidget: { name } });
    // CreateWidgetResponse has no field pre-assigned by the caller
    // (widgetId is server-generated) — name is the best available
    // correlator when creating two widgets back to back. Imprecise if both
    // are given the same name concurrently, same tradeoff as webapp's
    // evergram-client.ts createWidget().
    return this.requestWithReauth(
      msg,
      "createWidgetResponse",
      undefined,
      (v) => v.widget?.name === name,
    );
  }

  async deleteWidget(widgetId: string) {
    const msg = ClientMessage.create({ deleteWidget: { widgetId } });
    return this.requestWithReauth(
      msg,
      "deleteWidgetResponse",
      undefined,
      (v) => v.widgetId === widgetId,
    );
  }

  async updateWidget(widgetId: string, opts: { enabled?: boolean }) {
    const msg = ClientMessage.create({ updateWidget: { widgetId, enabled: opts.enabled } });
    return this.requestWithReauth(
      msg,
      "updateWidgetResponse",
      undefined,
      (v) => v.widget?.widgetId === widgetId,
    );
  }

  async listWidgets() {
    const msg = ClientMessage.create({ listWidgets: {} });
    return this.requestWithReauth(msg, "listWidgetsResponse");
  }

  // Deliberately plain request(), not requestWithReauth() — the gateway
  // answers this one with no authorization check at all (see the webapp
  // proto's comment on GetWidgetInfo), so the reauth-retry path can never
  // actually trigger here.
  async getWidgetInfo(widgetId: string) {
    const msg = ClientMessage.create({ getWidgetInfo: { widgetId } });
    return this.request(msg, "getWidgetInfoResponse", undefined, (v) => v.widgetId === widgetId);
  }

  // Sets/replaces this widget's stored config (colors, welcome copy, mode,
  // and — for public_group — the channel_key new visitors will join with).
  async updateWidgetConfig(widgetId: string, config: WidgetConfig) {
    const msg = ClientMessage.create({ updateWidgetConfig: { widgetId, config } });
    return this.requestWithReauth(
      msg,
      "updateWidgetConfigResponse",
      undefined,
      (v) => v.widgetId === widgetId,
    );
  }

  // Authenticated-only (see the gateway's subscribePublicChannel.ts): joins
  // this bot into its own widget's public_group channel as an operator —
  // auto-opped, same as the webapp owner's live-arrival session. channelKey
  // is the widget's stored config.channelKey (hex); the gateway replies
  // with the channel's ACTUAL key in effect, which this call adopts even if
  // it differs from what was passed (see publicChannelRegistry.ts's
  // ensureChannel comment on stale local copies). On success, wires up a
  // VisitorSessionHandle-compatible session for the returned roomToken —
  // sendVisitorMessage/reactToVisitorMessage/etc. all work against it
  // exactly like a 1:1 visitor room, keyed by the same roomToken.
  async subscribePublicChannel(widgetId: string, channelKeyHex: string) {
    const msg = ClientMessage.create({
      subscribePublicChannel: { widgetId, channelKey: channelKeyHex },
    });
    // Disambiguates concurrent subscribePublicChannel() calls (e.g. a bot
    // managing several widgets) — mirrors webapp's evergram-client.ts fix.
    const resp = await this.requestWithReauth(
      msg,
      "subscribePublicChannelResponse",
      undefined,
      (v) => v.widgetId === widgetId,
    );

    if (resp.status?.ok && resp.roomToken) {
      const adoptedKeyHex = resp.channelKey || channelKeyHex;
      this.createVisitorSession(resp.roomToken, hexToBytes(adoptedKeyHex), {
        widgetId,
        visitorLabel: "",
        origin: "",
        isChannel: true,
        channelKeyHex: adoptedKeyHex,
      });
    }

    return resp;
  }

  // IRC-style moderation for a channel this bot is subscribed to (kick,
  // ban, unban, grant/revoke op or voice, toggle +m) — see ModerationAction.
  // Authorization (must currently be op) is enforced gateway-side; a
  // non-op caller gets back status.ok=false, code "FORBIDDEN".
  async moderateChannel(roomToken: string, action: ModerationAction, targetParticipant?: string) {
    const msg = ClientMessage.create({ moderateChannel: { roomToken, action, targetParticipant } });
    return this.requestWithReauth(
      msg,
      "moderateChannelResponse",
      undefined,
      (v) => v.roomToken === roomToken,
    );
  }

  // sender defaults to this bot's own profile nickname, mirroring the
  // webapp owner-side UX (defaults to the agent's real nickname instead of
  // "Anonymous," still overridable per call).
  sendVisitorMessage(roomToken: string, text: string, sender?: string): EphemeralTextEvent {
    return this.getVisitorSessionOrThrow(roomToken).session.send(
      text,
      sender ?? this.profile?.nickname ?? "",
    );
  }

  reactToVisitorMessage(roomToken: string, msgId: string, emoji: string | null): void {
    this.getVisitorSessionOrThrow(roomToken).session.sendReaction(msgId, emoji);
  }

  editVisitorMessage(roomToken: string, msgId: string, text: string): EphemeralEditEvent {
    return this.getVisitorSessionOrThrow(roomToken).session.editMessage(msgId, text);
  }

  removeVisitorMessage(roomToken: string, msgId: string): EphemeralRemoveEvent {
    return this.getVisitorSessionOrThrow(roomToken).session.removeMessage(msgId);
  }

  sendVisitorTyping(roomToken: string, isTyping: boolean): void {
    this.getVisitorSessionOrThrow(roomToken).session.sendTyping(isTyping);
  }

  // public_group only — announces this bot's nickname to the channel's
  // roster (see EphemeralRelaySession.announcePresence). Call once after
  // subscribePublicChannel resolves, and again on any later rename.
  announceChannelPresence(roomToken: string, sender: string, previousSender?: string): void {
    const entry = this.getVisitorSessionOrThrow(roomToken);
    entry.session.announcePresence(sender, previousSender);
    entry.lastAnnouncedSender = sender;
  }

  // Permanently closes the room (see ephemeralRoomRegistry.ts's endRoom on
  // the gateway) — unlike just disconnecting, the visitor is notified
  // immediately and can't reconnect into it afterward.
  endVisitorRoom(roomToken: string): void {
    const entry = this.getVisitorSessionOrThrow(roomToken);
    entry.session.end();
    this.visitorSessions.delete(roomToken);
  }

  // Read-only projection of the internal registry, for EvergramBot to
  // reconstruct a VisitorSessionHandle's metadata for events that only
  // carry a roomToken (visitorMessage/visitorReaction/etc.) — deliberately
  // doesn't expose the EphemeralRelaySession instance itself.
  getVisitorSession(
    roomToken: string,
  ): { widgetId: string; visitorLabel: string; origin: string } | undefined {
    const entry = this.visitorSessions.get(roomToken);
    if (!entry) return undefined;
    return { widgetId: entry.widgetId, visitorLabel: entry.visitorLabel, origin: entry.origin };
  }

  private getVisitorSessionOrThrow(roomToken: string) {
    const entry = this.visitorSessions.get(roomToken);
    if (!entry) {
      throw new EvergramNotFoundError(
        "visitor_room_not_found",
        `Unknown or expired visitor room ${roomToken}`,
      );
    }
    return entry;
  }

  // Fire-and-forget, mirroring sendRelayMessage in the webapp's
  // evergram-client.ts — no request/response pair on the wire for any
  // RelayMessage kind, the gateway just relays it onward (or doesn't).
  private sendRelayMessage(roomToken: string, kind: RelayMessageKind, payloadText: string): void {
    this.transport.send(
      ClientMessage.create({
        relayMessage: {
          roomToken,
          kind: toWireKind(kind),
          payload: encodeRelayPayload(payloadText),
        },
      }),
    );
  }

  // Re-announces "joined" for every visitor room this process is still
  // tracking, on every (re)connection — not just the first time a room is
  // registered. Deliberate improvement over the webapp, which only does
  // this once at initial registration (a known, documented gap there) —
  // a long-running bot process hits transport reconnects far more often
  // than a browser tab ever does, so leaving this gap unfixed here would
  // bite much harder. See joinRoom/reclaimCreatorSlot in
  // ephemeralRoomRegistry.ts for why a fresh "joined" safely reclaims an
  // idle joiner slot within its reconnect grace window either way.
  private resyncVisitorSessions(): void {
    for (const [roomToken, entry] of this.visitorSessions) {
      if (entry.isChannel) {
        // A channel subscription isn't a slot in ephemeralRoomRegistry —
        // resending "joined" would hit the 1:1 joinRoom path with an
        // unrecognized token and fail. Re-subscribing is what actually
        // rejoins: ensureChannel on the gateway returns the same roomToken
        // for a still-live channel, so this transparently resumes the
        // existing conversation rather than starting a new one.
        //
        // The gateway's channel roster ties a participant's name to the
        // live WebSocket (publicChannelRegistry.ts's Subscriber), not to
        // the identity — a reconnect always lands on a brand-new socket
        // with no name recorded yet, even though subscribePublicChannel
        // re-auto-ops it. Left alone, this bot's own roster entry silently
        // disappears (the old socket's close broadcasts a PART for it, but
        // nothing ever re-announces a JOIN for the new one) until the
        // caller happens to call announceChannelPresence again by hand.
        // Re-announcing here with the last name this session actually used
        // — the same recovery the 1:1 branch below gets for free via
        // resent "joined" — keeps the roster consistent across reconnects.
        const lastAnnouncedSender = entry.lastAnnouncedSender;
        this.subscribePublicChannel(entry.widgetId, entry.channelKeyHex ?? "")
          .then((resp) => {
            if (resp.status?.ok && resp.roomToken && lastAnnouncedSender) {
              this.announceChannelPresence(resp.roomToken, lastAnnouncedSender);
            }
          })
          .catch((err) => this.emit("error", err));
        continue;
      }
      this.sendRelayMessage(roomToken, "joined", "");
    }
  }

  // Shared by handleVisitorRoomRequestedEvent (a room arriving live, key
  // freshly unsealed), registerVisitorSession (a room rehydrated from
  // whatever a long-running bot persisted itself across a restart), and
  // subscribePublicChannel (a public_group channel this bot explicitly
  // joined) — all end up with the same {roomToken, symKey, ...meta}, just
  // from different sources, and need identical wiring. The four
  // channel-only callbacks (onParticipantJoin/Leave/onModeChange/onKicked)
  // are wired unconditionally — they simply never fire for a 1:1 room,
  // since the gateway never sends RELAY_CHANNEL_* frames on one.
  private createVisitorSession(
    roomToken: string,
    symKey: Uint8Array,
    meta: {
      widgetId: string;
      visitorLabel: string;
      origin: string;
      isChannel?: boolean;
      channelKeyHex?: string;
    },
  ): void {
    const session = new EphemeralRelaySession({
      symKey,
      sendFrame: (kind, payload) => this.sendRelayMessage(roomToken, kind, payload),
      onMessage: (e) => this.emit("visitorMessage", { roomToken, ...e }),
      onReaction: (e) => this.emit("visitorReaction", { roomToken, ...e }),
      onEdit: (e) => this.emit("visitorMessageEdited", { roomToken, ...e }),
      onRemove: (e) => this.emit("visitorMessageDeleted", { roomToken, ...e }),
      onTyping: (e) => this.emit("visitorTyping", { roomToken, ...e }),
      onParticipantJoin: (sender, previousSender) =>
        this.emit("visitorChannelParticipantJoined", { roomToken, sender, previousSender }),
      onParticipantLeave: (sender) =>
        this.emit("visitorChannelParticipantLeft", { roomToken, sender }),
      onModeChange: (state) => this.emit("visitorChannelModeChanged", { roomToken, ...state }),
      onKicked: (reason) => this.emit("visitorKicked", { roomToken, reason }),
      onStatusChange: (status, statusMeta) => {
        // Mirrors endVisitorRoom's own cleanup for the self-initiated case
        // — "closed" can also arrive remotely (the visitor ending the
        // chat, or this device losing a join/reclaim race to another of
        // this bot's own devices). Without this, the entry lingers forever
        // and resyncVisitorSessions keeps re-sending "joined" for a room
        // that's already gone, on every future reconnect.
        if (status === "closed") this.visitorSessions.delete(roomToken);
        this.emit("visitorStatusChanged", {
          roomToken,
          status,
          peerLeftDeadline: statusMeta?.peerLeftDeadline,
        });
      },
    });

    this.visitorSessions.set(roomToken, { session, ...meta });
  }

  // Rehydrates a visitor room this process was a party to before a restart
  // — there is no contract/gateway-side record of active rooms (see the
  // developer docs' "no offline inbox, no persistence" — this relay is
  // in-memory only), so a freshly-started process has no way to know one
  // ever existed unless the caller persisted it themselves (capture
  // {roomToken, symKey, widgetId, visitorLabel, origin} from the
  // "visitorRoomRequested" event when the room first arrives, drop it once
  // "visitorStatusChanged" reports "closed"). Call before connect(): once
  // authenticated, resyncVisitorSessions() sends "joined" for every
  // registered room, which reclaims this room's joiner slot from the
  // gateway the same way a bare transport reconnect already does, as long
  // as it's within ephemeralRoomRegistry.ts's RECONNECT_GRACE_MS window.
  registerVisitorSession(meta: {
    roomToken: string;
    symKey: Uint8Array;
    widgetId: string;
    visitorLabel: string;
    origin: string;
  }): void {
    if (this.visitorSessions.has(meta.roomToken)) return;
    this.createVisitorSession(meta.roomToken, meta.symKey, meta);
  }

  private handleVisitorRoomRequestedEvent(event: VisitorRoomRequestedEvent): void {
    const sealed = event.sealedKeyByDevice[this.device.deviceId];
    if (!sealed) return; // sealed for a different device of this same identity, not this one

    const symKey = openSealedSymKey(
      {
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        ephemeralPubkey: sealed.ephemeralPubkey,
      },
      this.device.devicePrivHex,
    );
    if (!symKey) {
      this.emit(
        "error",
        new EvergramValidationError(
          "visitor_room_key_unsealable",
          `failed to open visitor room ${event.roomToken}'s symmetric key with this device's private key`,
        ),
      );
      return;
    }

    const firstMessage = decryptTextFramePayload(
      symKey,
      decodeRelayPayload(event.firstMessagePayload),
    );

    this.createVisitorSession(event.roomToken, symKey, {
      widgetId: event.widgetId,
      visitorLabel: event.visitorLabel,
      origin: event.origin,
    });

    // Eagerly join — flips the visitor's own UI from "waiting" to
    // "connected" without this bot doing anything further.
    this.sendRelayMessage(event.roomToken, "joined", "");

    this.emit("visitorRoomRequested", {
      roomToken: event.roomToken,
      widgetId: event.widgetId,
      visitorLabel: event.visitorLabel,
      origin: event.origin,
      ts: Number(event.ts),
      firstMessage,
      symKey,
    });
  }

  private handleRelayFrame(frame: WireRelayMessage): void {
    const entry = this.visitorSessions.get(frame.roomToken);
    if (!entry) return; // room unknown to this process (never ours, or already ended) — nothing to do

    const kind = fromWireKind(frame.kind);
    if (!kind) return;

    entry.session.handleFrame(kind, decodeRelayPayload(frame.payload));
  }

  // ===================== internal wire plumbing =====================

  private getChatOrThrow(chatId: string): ChatInfo {
    const chat = this.chats.get(chatId);
    if (!chat) {
      throw new EvergramNotFoundError("chat_not_found", `Unknown chat ${chatId}`);
    }
    return chat;
  }

  private getSymKeyOrThrow(chatId: string): Uint8Array {
    const symKey = this.symKeys.get(chatId);
    if (!symKey) {
      throw new EvergramNotFoundError(
        "chat_key_unknown",
        `No symmetric key known for chat ${chatId} yet — call syncChats() or wait for the chat to be established`,
      );
    }
    return symKey;
  }

  // Registers a one-shot waiter for the next ServerMessage carrying
  // `expectedField`, without sending anything — used both by request() (which
  // sends a message first) and by anything waiting on an unsolicited push,
  // like the gateway's AuthChallenge sent right after connect.
  private waitForMessage<K extends keyof ServerMessage>(
    expectedField: K,
    timeoutMs = this.requestTimeoutMs,
    matcher?: (value: NonNullable<ServerMessage[K]>) => boolean,
    requestId?: number,
  ): Promise<NonNullable<ServerMessage[K]>> {
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = {
        expectedField,
        resolve,
        reject,
        matcher,
        requestId,
        timer: setTimeout(() => {
          this.discardPending(entry);
          reject(new EvergramTimeoutError("timeout", `Timeout waiting for ${expectedField}`));
        }, timeoutMs),
      };

      this.pendingRequests.push(entry);
      if (requestId) this.pendingByRequestId.set(requestId, entry);
    });
  }

  // Removes a settled/timed-out waiter from every structure it's tracked
  // in — forgetting the Map half of this would leak an entry per request
  // for the lifetime of the connection.
  private discardPending(entry: PendingRequest): void {
    const idx = this.pendingRequests.indexOf(entry);
    if (idx !== -1) this.pendingRequests.splice(idx, 1);
    if (entry.requestId) this.pendingByRequestId.delete(entry.requestId);
    clearTimeout(entry.timer);
  }

  private request<K extends keyof ServerMessage>(
    msg: ClientMessage,
    expectedField: K,
    timeoutMs = this.requestTimeoutMs,
    matcher?: (value: NonNullable<ServerMessage[K]>) => boolean,
  ): Promise<NonNullable<ServerMessage[K]>> {
    const requestId = this.nextRequestId++;
    if (this.nextRequestId > 0xffffffff) this.nextRequestId = 1;

    const pending = this.waitForMessage(expectedField, timeoutMs, matcher, requestId);
    this.transport.send({ ...msg, requestId });
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
    timeoutMs = this.requestTimeoutMs,
    matcher?: (value: NonNullable<ServerMessage[K]>) => boolean,
  ): Promise<NonNullable<ServerMessage[K]>> {
    try {
      return await this.request(msg, expectedField, timeoutMs, matcher);
    } catch (err) {
      if (err instanceof EvergramAuthError) {
        await this.reconnectAndAuthenticate();
        return this.request(msg, expectedField, timeoutMs, matcher);
      }
      throw err;
    }
  }

  // Can't just re-run authenticate() on the same connection: the gateway
  // pushes its AuthChallenge nonce exactly once, at connection-open, and
  // never re-validates a connection it has already accepted. A second
  // authenticate() on the same socket would
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
  // rotateChatVersionResponse in the same output, and
  // ts-proto does not enforce oneof exclusivity at runtime. Check every
  // pending waiter against this message rather than stopping at the first
  // match.
  private resolvePendingRequests(msg: ServerMessage): void {
    // This runs on every incoming ServerMessage, including plain pushes
    // (TYPING/SEND/REACT envelopes) that never carry a oneof response
    // field — bail before doing any work on the common case of no
    // in-flight request() calls at all.
    if (this.pendingRequests.length === 0) {
      if (msg.error)
        this.emit("error", errorFromCode(msg.error.code || msg.error.type, msg.error.message));
      return;
    }

    // request_id is authoritative when present on both sides — an exact
    // match is resolved directly (O(1), no type/matcher guessing), and this
    // ALWAYS returns without falling through to the type/matcher/bare-error
    // logic below, whether or not a matching entry was found. A requestId
    // set on the incoming message but absent from pendingByRequestId means
    // this response is definitively for a call that's no longer waiting
    // (already resolved, or timed out and discarded) — NOT for some other
    // unrelated concurrent same-type call. Falling through in that case
    // (an earlier version of this code did) re-opens exactly the cross-
    // resolve bug requestId exists to close: a late/duplicate response for
    // a discarded request would hit the type loop's FIFO fallback or the
    // bare-error fallback and silently resolve/reject a DIFFERENT in-flight
    // call with the wrong result. Any data this message also carries (e.g.
    // a bundled rotateChatVersionResponse alongside addParticipantResponse
    // — ts-proto doesn't enforce oneof exclusivity at runtime) is still
    // applied to local state via handlePush() below regardless; a genuinely
    // separate pending call for that same field gets its own dedicated,
    // correctly-tagged response from the gateway rather than needing to
    // scavenge one off an unrelated message.
    if (msg.requestId) {
      const entry = this.pendingByRequestId.get(msg.requestId);
      if (entry) {
        const value = (msg as any)[entry.expectedField];
        this.discardPending(entry);

        if (value !== undefined && value.status && value.status.ok === false) {
          entry.reject(errorFromCode(value.status.code, value.status.message));
        } else if (value !== undefined) {
          entry.resolve(value);
        } else if (msg.error) {
          entry.reject(errorFromCode(msg.error.code || msg.error.type, msg.error.message));
        } else {
          entry.reject(
            new Error(
              `Received requestId-matched response with no ${String(entry.expectedField)} or error`,
            ),
          );
        }
      }
      return;
    }

    const resolvedTypes = new Set<keyof ServerMessage>();

    for (const expectedField of new Set(this.pendingRequests.map((e) => e.expectedField))) {
      if (resolvedTypes.has(expectedField)) continue;

      const value = (msg as any)[expectedField];
      if (value === undefined) continue;

      // A oneof field only ever carries one value per message, so at most
      // one waiter of this type can legitimately be resolved by it. Prefer
      // a waiter whose matcher confirms this value is actually theirs (e.g.
      // getProfileResponse.remoteIdentity matching the identity they asked
      // for) over plain FIFO — otherwise two concurrent same-type calls can
      // resolve each other's promise with the wrong result.
      //
      // Single pass over pendingRequests (not filter+find+indexOf, which
      // scans the array twice and allocates a throwaway candidates array)
      // — matcherIdx wins if found (and short-circuits the loop, since it's
      // the best possible outcome), else the first waiter with no matcher,
      // else just the first waiter of this type.
      //
      // The no-matcher/first-of-type fallback is deliberate, not a gap:
      // some contract error paths (e.g. handleAddParticipant's not_admin/
      // chat_not_found/membership_conflict branches) return status.ok=false
      // without echoing back chatId/remoteIdentity, so a matcher can have
      // nothing to match against. Without this fallback that leaves every
      // matcher-holding waiter of this type unresolved until it times out —
      // the same "Timeout waiting for X" symptom masking a real error that
      // webapp's _sendAndWaitResponse hit historically (see its
      // hasOtherField comment) before that fallback was added there. Best
      // effort here means the same FIFO guess this code made before
      // matchers existed, never a hang.
      let matcherIdx = -1;
      let noMatcherIdx = -1;
      let firstIdx = -1;
      for (let i = 0; i < this.pendingRequests.length; i++) {
        const candidate = this.pendingRequests[i];
        if (candidate.expectedField !== expectedField) continue;
        if (firstIdx === -1) firstIdx = i;
        if (noMatcherIdx === -1 && !candidate.matcher) noMatcherIdx = i;
        if (candidate.matcher?.(value)) {
          matcherIdx = i;
          break;
        }
      }
      const idx = matcherIdx !== -1 ? matcherIdx : noMatcherIdx !== -1 ? noMatcherIdx : firstIdx;
      if (idx === -1) continue;

      const entry = this.pendingRequests[idx];
      resolvedTypes.add(expectedField);
      this.discardPending(entry);

      if (value.status && value.status.ok === false) {
        entry.reject(errorFromCode(value.status.code, value.status.message));
      } else {
        entry.resolve(value);
      }
    }

    // Only reached when msg.requestId is falsy (the requestId branch above
    // always returns otherwise) — talking to a gateway that predates
    // request_id, or a genuinely untagged push-adjacent error. A bare error
    // not tied to any specific field is attributed to the oldest pending
    // request, best-effort, same as webapp's _sendAndWaitResponse fallback.
    if (msg.error && this.pendingRequests.length > 0) {
      const entry = this.pendingRequests[0];
      this.discardPending(entry);
      entry.reject(errorFromCode(msg.error.code || msg.error.type, msg.error.message));
    } else if (msg.error) {
      this.emit("error", errorFromCode(msg.error.code || msg.error.type, msg.error.message));
    }
  }

  private handlePush(msg: ServerMessage): void {
    if (msg.authResponse?.access) {
      this.isRestricted = !!msg.authResponse.access.isRestricted;
    }

    if (msg.authResponse?.status?.ok) {
      this.profile = msg.authResponse.profile;
      this.profileStatus = msg.authResponse.profileStatus;
    }

    const chatCandidates: ChatInfo[] = [];
    if (msg.createChatResponse?.chat) chatCandidates.push(msg.createChatResponse.chat);
    if (msg.acceptChatRequestResponse?.chat)
      chatCandidates.push(msg.acceptChatRequestResponse.chat);
    if (msg.rotateChatVersionResponse?.chat)
      chatCandidates.push(msg.rotateChatVersionResponse.chat);
    for (const result of msg.queryChatsResponse?.results ?? []) {
      if (result.chat) chatCandidates.push(result.chat);
      // The server no longer has this chat (removed/archived) — prune it
      // locally so syncChats() stops re-sending its version forever, and
      // let bot consumers react (e.g. stop scheduling sends to it).
      if (result.status === ChatSyncResult_Status.MISSING && result.chatId) {
        if (this.chats.delete(result.chatId)) {
          this.emit("chatRemoved", result.chatId);
        }
      }
    }
    for (const chat of chatCandidates) this.processChatInfo(chat);

    // Boot sync: silently merge, mirroring how queryChatsResponse.results
    // above updates `chats` without emitting per-item events.
    for (const req of msg.queryChatsResponse?.pendingChatRequests ?? []) {
      if (req.fromIdentity)
        this.boundedMapSet(
          this.pendingChatRequests,
          req.fromIdentity,
          req,
          MAX_PENDING_CHAT_REQUESTS,
        );
    }

    // Live push: a CreateChat from another identity is awaiting our
    // approval right now — this one is event-worthy, mirroring joinRequestedEvent.
    if (msg.chatRequestReceived?.request) {
      const req = msg.chatRequestReceived.request;
      if (req.fromIdentity)
        this.boundedMapSet(
          this.pendingChatRequests,
          req.fromIdentity,
          req,
          MAX_PENDING_CHAT_REQUESTS,
        );
      this.emit("chatRequestReceived", req);
    }

    for (const invite of msg.queryChatsResponse?.pendingGroupInvites ?? []) {
      if (invite.chatId)
        this.boundedMapSet(
          this.pendingGroupInvites,
          invite.chatId,
          invite,
          MAX_PENDING_GROUP_INVITES,
        );
    }

    if (msg.groupInviteReceived?.invite) {
      const invite = msg.groupInviteReceived.invite;
      if (invite.chatId)
        this.boundedMapSet(
          this.pendingGroupInvites,
          invite.chatId,
          invite,
          MAX_PENDING_GROUP_INVITES,
        );
      this.emit("groupInviteReceived", invite);
    }

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

    if (msg.joinDeniedEvent) {
      this.emit("joinDenied", msg.joinDeniedEvent);
    }

    if (msg.visitorRoomRequestedEvent) {
      this.handleVisitorRoomRequestedEvent(msg.visitorRoomRequestedEvent);
    }

    if (msg.relayMessage) {
      this.handleRelayFrame(msg.relayMessage);
    }

    if (msg.visitorRoomTimedOutEvent) {
      this.emit("visitorRoomTimedOut", msg.visitorRoomTimedOutEvent);
    }
  }

  // Catches a corrupted/mismatched devicePrivHex (truncated, bit-flipped,
  // wrong file loaded — anything that can happen wherever the caller
  // persists and reloads it) right at construction, loud and synchronous.
  // Without this, the bot connects and authenticates fine (auth uses the
  // wallet key, not the device key) and only fails silently, deep inside
  // processChatInfo below, the first time it tries to open a chat key.
  private assertDeviceKeypairValid(device: EvergramDevice): void {
    let derivedPubHex: string;
    try {
      derivedPubHex = deriveDevicePubHex(device.devicePrivHex);
    } catch {
      throw new EvergramValidationError(
        "invalid_device_private_key",
        "device.devicePrivHex is not a valid X25519 private key (wrong length/format) — check wherever it's persisted/reloaded for truncation or corruption",
      );
    }

    const normalizedPubHex = device.devicePubHex.toLowerCase().replace(/^0x/, "");
    if (derivedPubHex !== normalizedPubHex) {
      throw new EvergramValidationError(
        "device_key_mismatch",
        "device.devicePrivHex does not match device.devicePubHex — this device will never be able to decrypt any chat key; check wherever this keypair is persisted/reloaded for corruption",
      );
    }
  }

  // Mirrors the webapp client's own processChat(): derive this device's
  // symmetric key from the sealed envelope the gateway produced, cache the
  // chat, and drain any messages that arrived before the key was known.
  private processChatInfo(chat: ChatInfo): void {
    if (!chat.chatId) return;

    this.chats.set(chat.chatId, chat);

    const sealed = chat.symKeyEncrypted?.[this.selfIdentityKey]?.devices?.[this.device.deviceId];
    if (!sealed) return;

    const opened = openSealedSymKey(
      {
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        ephemeralPubkey: sealed.ephemeralPubkey,
      },
      this.device.devicePrivHex,
    );
    if (!opened) {
      // assertDeviceKeypairValid already rules out a mismatched device key —
      // reaching here means this specific chat's sealed envelope itself is
      // bad. Rare, but silently dropping it left messages queued forever in
      // pendingEnvelopes with zero signal (see README's "Caught two real
      // bugs" #2 for the same failure shape with a different root cause).
      this.emit(
        "error",
        new EvergramValidationError(
          "chat_key_unsealable",
          `failed to open chat ${chat.chatId}'s symmetric key with this device's private key — its messages will queue forever until this is resolved`,
        ),
      );
      return;
    }

    const isRotation = this.symKeys.has(chat.chatId);
    this.symKeys.set(chat.chatId, opened);

    if (isRotation) this.emit("chatKeyRotated", { chatId: chat.chatId });

    this.drainPending(chat.chatId);
  }

  private handleEnvelope(env: Envelope): void {
    if (env.type === "SEND" && env.send) {
      this.deliverOrQueue(env);
    } else if (env.type === "REACT" && env.react) {
      this.deliverOrQueue(env);
    } else if (env.type === "EDIT" && env.edit) {
      this.deliverOrQueue(env);
    } else if (env.type === "TYPING") {
      this.emit("typing", {
        chatId: env.chatId,
        sender: env.sender,
        isTyping: !!env.typing?.isTyping,
      });
    } else if (env.type === "DELIVERY" && env.delivery) {
      const isSendEvent = !env.delivery.eventType || env.delivery.eventType === "SEND";

      if (isSendEvent && env.delivery.status?.code === "ROTATION_REQUIRED") {
        // Swallowed here (and replaced by a resend, or a terminal error
        // event) rather than falling through to the plain "delivery"
        // failure below — see retrySendOnRotationRequired().
        if (this.retrySendOnRotationRequired(env.delivery.msgId)) return;
      } else if (isSendEvent) {
        this.pendingSends.delete(env.delivery.msgId);
      }

      // eventType ("SEND"/"REACT"/"EDIT") lets a bot author tell "my
      // original message failed to send" apart from "a later react/edit/
      // delete attempt on it was rejected" — reactToMessage()/editMessage()/
      // deleteMessage() are fire-and-forget like sendMessage(), so this
      // "delivery" event (not the returned Promise) is the only place that
      // outcome is observable.
      this.emit("delivery", {
        chatId: env.chatId,
        msgId: env.delivery.msgId,
        status: env.delivery.status,
        eventType: env.delivery.eventType || "SEND",
      });
    }
  }

  // FIFO-evicting Map.set — see MAX_PENDING_CHAT_REQUESTS/MAX_PENDING_GROUP_INVITES.
  private boundedMapSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
    if (!map.has(key) && map.size >= max) {
      const oldestKey = map.keys().next().value!;
      map.delete(oldestKey);
    }
    map.set(key, value);
  }

  // Mirrors the webapp client's own pendingRef/flushPendingForChat pattern:
  // an envelope can arrive before this device has derived the chat's
  // symmetric key (e.g. right after being added to a chat). Queue it and
  // decrypt once processChatInfo() makes the key available.
  private deliverOrQueue(env: Envelope): void {
    const symKey = this.symKeys.get(env.chatId);
    if (!symKey) {
      const queue = this.pendingEnvelopes.get(env.chatId) ?? [];
      queue.push(env);

      if (queue.length > MAX_PENDING_ENVELOPES_PER_CHAT) {
        queue.shift();
        this.emit(
          "error",
          new EvergramValidationError(
            "pending_envelope_queue_overflow",
            `chat ${env.chatId}'s key never resolved after ${MAX_PENDING_ENVELOPES_PER_CHAT} queued envelopes — dropping the oldest. Check chatKeyRotated/error events for this chat.`,
          ),
        );
      }

      if (
        !this.pendingEnvelopes.has(env.chatId) &&
        this.pendingEnvelopes.size >= MAX_PENDING_CHATS
      ) {
        const oldestChatId = this.pendingEnvelopes.keys().next().value!;
        this.pendingEnvelopes.delete(oldestChatId);
        this.emit(
          "error",
          new EvergramValidationError(
            "pending_chat_queue_overflow",
            `${MAX_PENDING_CHATS} distinct chats have envelopes awaiting their key — dropping the oldest chat's queue (${oldestChatId}).`,
          ),
        );
      }

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

  // Replay/duplicate suppression for the decrypt path — the gateway is
  // untrusted transport and redelivers envelopes on reconnect/resync (see
  // context/boundaries.md). nacl.secretbox itself has no nonce-reuse
  // tracking, so a replayed envelope decrypts successfully again unless
  // caught here. Keyed by envelope type + msgId + that type's own nonce
  // (falling back to ts when nonce is empty, e.g. removed reacts/edits) so
  // a *legitimate* EDIT to an already-seen msgId is never mistaken for a
  // duplicate SEND — each carries its own nonce and its own "SEND:"/"EDIT:"
  // prefix, only an exact envelope redelivery collides. Mirrors the
  // webapp client's own getMessageKey/dedupeMessages.
  private envelopeDedupeKey(env: Envelope): string | null {
    if (env.type === "SEND" && env.send) {
      return `SEND:${env.send.msgId}:${env.send.nonce}`;
    }
    if (env.type === "REACT" && env.react) {
      return `REACT:${env.react.msgId}:${env.react.nonce || env.ts}:${env.react.removed ? "1" : "0"}`;
    }
    if (env.type === "EDIT" && env.edit) {
      return `EDIT:${env.edit.msgId}:${env.edit.nonce || env.edit.editedAt || env.ts}:${env.edit.removed ? "1" : "0"}`;
    }
    return null;
  }

  private isDuplicateEnvelope(env: Envelope): boolean {
    const key = this.envelopeDedupeKey(env);
    if (key === null) return false;
    if (this.seenEnvelopeKeys.has(key)) return true;

    this.seenEnvelopeKeys.set(key, true);
    if (this.seenEnvelopeKeys.size > MAX_SEEN_ENVELOPE_KEYS) {
      const oldest = this.seenEnvelopeKeys.keys().next().value;
      if (oldest !== undefined) this.seenEnvelopeKeys.delete(oldest);
    }
    return false;
  }

  private decryptAndEmit(env: Envelope, symKey: Uint8Array): void {
    if (this.isDuplicateEnvelope(env)) return;

    if (env.send) {
      const text = decryptMessage(symKey, env.send.nonce, env.send.ciphertext);
      const content = parseMessageContent(text);

      this.originalContentTypeByMsgId.set(env.send.msgId, content.type);
      if (this.originalContentTypeByMsgId.size > MAX_ORIGINAL_CONTENT_TYPES) {
        const oldest = this.originalContentTypeByMsgId.keys().next().value;
        if (oldest !== undefined) this.originalContentTypeByMsgId.delete(oldest);
      }

      const message: EvergramChatMessage = {
        chatId: env.chatId,
        sender: env.sender,
        msgId: env.send.msgId,
        ts: env.ts,
        text,
        content,
      };

      this.emit("message", message);
    } else if (env.react) {
      const emoji = env.react.removed
        ? null
        : decryptMessage(symKey, env.react.nonce, env.react.ciphertext);

      const reaction: EvergramReaction = {
        chatId: env.chatId,
        sender: env.sender,
        msgId: env.react.msgId,
        emoji,
        removed: !!env.react.removed,
        ts: env.ts,
      };

      this.emit("reaction", reaction);
    } else if (env.edit) {
      if (env.edit.removed) {
        const deleted: EvergramMessageDeleted = {
          chatId: env.chatId,
          sender: env.sender,
          msgId: env.edit.msgId,
          removedAt: env.edit.editedAt || env.ts,
        };

        this.emit("messageDeleted", deleted);
      } else {
        const text = decryptMessage(symKey, env.edit.nonce, env.edit.ciphertext);
        const content = parseMessageContent(text);

        // Re-check the edit's content type against the original SEND's type
        // (see boundaries.md: recipients must independently re-validate,
        // never trust the sender). A malicious counterparty could otherwise
        // rewrite a plain-text message into e.g. a payment_request via a
        // crafted EDIT envelope. Known limitation: if this process never
        // saw the original SEND (bot started later, history-synced from
        // another device, etc.) originalType is unknown and the edit is
        // allowed through unchanged, same as before this check existed.
        const originalType = this.originalContentTypeByMsgId.get(env.edit.msgId);
        if (originalType === "text" && content.type !== "text") {
          return;
        }

        const edited: EvergramMessageEdited = {
          chatId: env.chatId,
          sender: env.sender,
          msgId: env.edit.msgId,
          text,
          content,
          editedAt: env.edit.editedAt || env.ts,
        };

        this.emit("messageEdited", edited);
      }
    }
  }
}
