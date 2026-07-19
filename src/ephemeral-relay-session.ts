import { decryptMessage, encryptMessage, generateMsgId } from "./crypto.js";
import { RelayMessageKind } from "./relay-message-codec.js";

// Ported from the webapp's app/lib/ephemeral-relay-session.ts — see
// [[evergram-sdk-relay-duplication]] memory. Keep this file's shape
// mirroring that one exactly so future protocol changes are easy to port.
export type EphemeralRelayStatus = "connecting" | "open" | "peer_left" | "closed";

export interface EphemeralTextEvent {
  msgId: string;
  sender: string;
  text: string;
  ts: number;
}

export interface EphemeralReactEvent {
  msgId: string;
  emoji: string | null; // null = the sender removed their own reaction
}

export interface EphemeralEditEvent {
  msgId: string;
  text: string;
  editedAt: number;
}

export interface EphemeralRemoveEvent {
  msgId: string;
  removedAt: number;
}

export interface EphemeralTypingEvent {
  isTyping: boolean;
  // public_group only — which participant this signal is about. Absent for
  // 1:1 rooms (exactly one other party, no roster to attribute to) and
  // absent on the synthetic "clear everything" event this session fires on
  // disconnect/reconnect (see markActivity call sites in handleFrame below).
  sender?: string;
}

// Builds the exact wire payload a RELAY_TEXT frame carries: encrypt the
// {msgId, sender, text, ts} envelope with the room's symKey, then JSON-wrap
// the {nonce, ciphertext} result. Exported (not just used internally by
// send() below) so callers can produce a first message in this same shape
// to bundle into CreateVisitorRoom, before any relay session/channel
// exists to send it through normally.
export function buildTextFramePayload(
  symKey: Uint8Array,
  sender: string,
  text: string
): { event: EphemeralTextEvent; payloadText: string } {
  const event: EphemeralTextEvent = {
    msgId: generateMsgId(),
    sender,
    text,
    ts: Date.now(),
  };
  const { nonce, ciphertext } = encryptMessage(symKey, JSON.stringify(event));
  return { event, payloadText: JSON.stringify({ nonce, ciphertext }) };
}

// Plaintext JSON, not the {nonce, ciphertext} envelope every other kind
// carries — see the gateway's ephemeralRoomRegistry.ts's notifyLeft.
// Absent or unparseable payload (the original magic-link feature never
// sends one) just means "no deadline known," not an error.
function parsePeerLeftDeadline(payloadText: string): number | undefined {
  try {
    return payloadText ? JSON.parse(payloadText)?.deadlineAt : undefined;
  } catch {
    return undefined;
  }
}

// Plaintext JSON, like parsePeerLeftDeadline above — RELAY_TYPING is
// deliberately not nacl-encrypted (see its proto comment): typing liveness
// isn't message content, and the real per-chat Envelope already lets the
// gateway see isTyping in the clear.
function parseTypingPayload(payloadText: string): EphemeralTypingEvent | null {
  try {
    const parsed = JSON.parse(payloadText);
    const isTyping = parsed?.isTyping;
    if (typeof isTyping !== "boolean") return null;
    const sender = parsed?.sender;
    return typeof sender === "string" && sender ? { isTyping, sender } : { isTyping };
  } catch {
    return null;
  }
}

// Plaintext JSON, same reasoning as parseTypingPayload — public_group
// presence, not message content (see RELAY_CHANNEL_JOIN/PART's proto
// comment).
function parseChannelPresencePayload(
  payloadText: string
): { sender: string; previousSender?: string } | null {
  try {
    const parsed = JSON.parse(payloadText);
    const sender = parsed?.sender;
    const previousSender = parsed?.previousSender;
    if (typeof sender !== "string" || !sender) return null;
    return typeof previousSender === "string" && previousSender
      ? { sender, previousSender }
      : { sender };
  } catch {
    return null;
  }
}

// Plaintext JSON, same reasoning as parseChannelPresencePayload —
// moderation state, not message content (see RELAY_CHANNEL_MODE's proto
// comment).
export interface EphemeralModerationState {
  moderated: boolean;
  ops: string[];
  voiced: string[];
}

function parseModerationStatePayload(payloadText: string): EphemeralModerationState | null {
  try {
    const parsed = JSON.parse(payloadText);
    if (typeof parsed?.moderated !== "boolean" || !Array.isArray(parsed?.ops) || !Array.isArray(parsed?.voiced)) {
      return null;
    }
    return { moderated: parsed.moderated, ops: parsed.ops, voiced: parsed.voiced };
  } catch {
    return null;
  }
}

function parseKickedPayload(payloadText: string): "kicked" | "banned" {
  try {
    return JSON.parse(payloadText)?.reason === "banned" ? "banned" : "kicked";
  } catch {
    return "kicked";
  }
}

// Shared by callers that wire onModeChange — turns a moderation state
// transition into the same kind of system-pill text RELAY_CHANNEL_JOIN/PART
// already produce, instead of duplicating this diff logic in each caller.
// `prev` is undefined on the very first snapshot (nothing to diff against
// yet, so no pills).
export function describeModerationChange(
  prev: EphemeralModerationState | undefined,
  next: EphemeralModerationState
): string[] {
  if (!prev) return [];
  const texts: string[] = [];
  if (prev.moderated !== next.moderated) {
    texts.push(next.moderated ? "Channel is now moderated (+m)" : "Channel is no longer moderated (-m)");
  }
  const added = (before: string[], after: string[]) => after.filter((n) => !before.includes(n));
  const removed = (before: string[], after: string[]) => before.filter((n) => !after.includes(n));
  for (const name of added(prev.ops, next.ops)) texts.push(`${name} was given operator status (+o)`);
  for (const name of removed(prev.ops, next.ops)) texts.push(`${name} lost operator status (-o)`);
  for (const name of added(prev.voiced, next.voiced)) texts.push(`${name} was given voice (+v)`);
  for (const name of removed(prev.voiced, next.voiced)) texts.push(`${name} lost voice (-v)`);
  return texts;
}

// Inverse of the above — decrypts the first message bundled into an
// incoming VisitorRoomRequestedEvent, before any EphemeralRelaySession
// instance exists yet to decode it through the generic decrypt() path
// below (which only ever sees frames AFTER a session is already wired up).
export function decryptTextFramePayload(symKey: Uint8Array, payloadText: string): EphemeralTextEvent | null {
  try {
    const { nonce, ciphertext } = JSON.parse(payloadText);
    const json = decryptMessage(symKey, nonce, ciphertext);
    return json == null ? null : JSON.parse(json);
  } catch {
    return null;
  }
}

export interface EphemeralStatusMeta {
  // Epoch ms — when the other side's reconnect grace window expires.
  // Only ever set alongside status "peer_left", and only for rooms the
  // gateway tracks a deadline for (see ephemeralRoomRegistry.ts's
  // notifyLeft). Optional second argument, so callers that only take one
  // keep compiling and behaving exactly as before.
  peerLeftDeadline?: number;
}

// Mirrors the gateway's ephemeralRoomRegistry.ts's IDLE_TTL_MS — the
// gateway resets its own clock on every relayed frame (either direction)
// and sweeps a paired room that's gone quiet for this long. The client has
// no server-pushed value to anchor this to (unlike peerLeftDeadline, which
// the gateway computes and sends), so this is a best-effort local
// approximation: reset whenever THIS session sees any frame go by, in
// either direction.
const IDLE_TTL_MS = 30 * 60_000;

export interface EphemeralRelaySessionOptions {
  symKey: Uint8Array;
  sendFrame: (kind: RelayMessageKind, payload: string) => void;
  onMessage: (event: EphemeralTextEvent) => void;
  onReaction: (event: EphemeralReactEvent) => void;
  onEdit: (event: EphemeralEditEvent) => void;
  onRemove: (event: EphemeralRemoveEvent) => void;
  onTyping: (event: EphemeralTypingEvent) => void;
  // public_group only — fires when another participant announces itself
  // (RELAY_CHANNEL_JOIN) or the gateway reports one disconnecting
  // (RELAY_CHANNEL_PART). Optional so 1:1 callers (which never receive
  // these kinds) don't need to pass anything.
  onParticipantJoin?: (sender: string, previousSender?: string) => void;
  onParticipantLeave?: (sender: string) => void;
  // public_group only — fires whenever a ModerateChannel action changes
  // the channel's moderated flag or op/voice roster (RELAY_CHANNEL_MODE).
  onModeChange?: (state: EphemeralModerationState) => void;
  // public_group only — fires when this connection itself was kicked or
  // banned (RELAY_CHANNEL_KICKED), right before the gateway closes the
  // socket. Callers should treat this like the "closed" status (see
  // onStatusChange) but with reason-specific copy.
  onKicked?: (reason: "kicked" | "banned") => void;
  onStatusChange: (status: EphemeralRelayStatus, meta?: EphemeralStatusMeta) => void;
  // Fires on every frame seen (sent or received) with the new "this room
  // goes stale at" deadline — separate from peerLeftDeadline (which is
  // about one side having dropped, not general silence). Optional so
  // callers that predate this aren't forced to handle it.
  onActivity?: (idleDeadline: number) => void;
}

// The gateway relays each frame between the two sockets paired on a
// roomToken (see the gateway's ephemeralRoomRegistry.ts), the same way it
// already relays every other message in the real chat — sidesteps NAT
// traversal entirely instead of fighting it.
//
// The wire-level `kind` (text/react/edit/remove) is visible to the
// gateway, same as Envelope.type is for the real chat — only the JSON
// underneath (msgId/sender/text/emoji) is encrypted, with a key that's
// sealed per-device and never sent to the gateway in the clear.
export class EphemeralRelaySession {
  private readonly opts: EphemeralRelaySessionOptions;
  // Mirrors evergram-client.ts's sendTyping/clearTyping debounce for the
  // real chat: a "true" starts the signal and arms a 3s auto-stop timer
  // that's refreshed (not re-sent) on every subsequent keystroke, so the
  // wire only ever sees one "start" frame per burst of typing plus one
  // "stop" frame, never a frame per keystroke.
  private typingTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: EphemeralRelaySessionOptions) {
    this.opts = opts;
  }

  private markActivity() {
    this.opts.onActivity?.(Date.now() + IDLE_TTL_MS);
  }

  private encryptAndSend(kind: RelayMessageKind, data: unknown) {
    const { nonce, ciphertext } = encryptMessage(this.opts.symKey, JSON.stringify(data));
    this.opts.sendFrame(kind, JSON.stringify({ nonce, ciphertext }));
    this.markActivity();
  }

  private decrypt<T>(payloadText: string): T | null {
    try {
      const { nonce, ciphertext } = JSON.parse(payloadText);
      const json = decryptMessage(this.opts.symKey, nonce, ciphertext);
      return json == null ? null : JSON.parse(json);
    } catch {
      return null;
    }
  }

  handleFrame(kind: RelayMessageKind, payloadText: string) {
    this.markActivity();

    if (kind === "joined" || kind === "reclaim") {
      this.opts.onStatusChange("open");
      // A reconnect/reclaim has no guarantee the other side's stop-typing
      // frame (sent, if at all, while this side was disconnected) actually
      // arrived — without this, a peer that was mid-"typing…" right before
      // the drop stays stuck showing typing forever after reconnecting,
      // since nothing else ever clears it. Clear-all (no sender) is safe
      // even in public_group: whoever's still actually typing re-sends
      // their own "true" on the next keystroke debounce.
      this.opts.onTyping({ isTyping: false });
      return;
    }

    if (kind === "left") {
      this.opts.onStatusChange("peer_left", { peerLeftDeadline: parsePeerLeftDeadline(payloadText) });
      this.opts.onTyping({ isTyping: false });
      return;
    }

    // "end": unlike "left", this is final — the room is gone, not just
    // missing one side, so there's no deadline/reconnect possible (see the
    // gateway's ephemeralRoomRegistry.ts's endRoom). "claimed_elsewhere":
    // the room itself is fine, it's just not this session's anymore (lost
    // a join/reclaim race to another device of the same owner identity) —
    // from this session's point of view there is nothing left to do but
    // the same cleanup, so it shares the "closed" status rather than
    // getting its own.
    if (kind === "end" || kind === "claimed_elsewhere") {
      this.opts.onStatusChange("closed");
      this.opts.onTyping({ isTyping: false });
      return;
    }

    // Receiving any content frame is itself proof the room is paired —
    // belt-and-suspenders alongside the gateway's direct join-ack, in case
    // that ever races or gets lost.
    this.opts.onStatusChange("open");

    if (kind === "text") {
      const event = this.decrypt<EphemeralTextEvent>(payloadText);
      if (event) this.opts.onMessage(event);
      return;
    }

    if (kind === "react") {
      const event = this.decrypt<EphemeralReactEvent>(payloadText);
      if (event) this.opts.onReaction(event);
      return;
    }

    if (kind === "edit") {
      const event = this.decrypt<EphemeralEditEvent>(payloadText);
      if (event) this.opts.onEdit(event);
      return;
    }

    if (kind === "remove") {
      const event = this.decrypt<EphemeralRemoveEvent>(payloadText);
      if (event) this.opts.onRemove(event);
      return;
    }

    if (kind === "typing") {
      const event = parseTypingPayload(payloadText);
      if (event) this.opts.onTyping(event);
      return;
    }

    // Deliberately NOT routed through onStatusChange above — unlike "left",
    // one participant departing a shared channel must never flip the whole
    // channel's status to "peer_left" (that's a 1:1-only concept). See the
    // proto comment on RELAY_CHANNEL_JOIN/RELAY_CHANNEL_PART.
    if (kind === "channel_join") {
      const event = parseChannelPresencePayload(payloadText);
      if (event) this.opts.onParticipantJoin?.(event.sender, event.previousSender);
      return;
    }

    if (kind === "channel_part") {
      const event = parseChannelPresencePayload(payloadText);
      if (event) {
        this.opts.onParticipantLeave?.(event.sender);
        // A participant who leaves mid-"typing…" has no further chance to
        // send its own stop-typing frame — without this it lingers in
        // everyone else's typing indicator forever.
        this.opts.onTyping({ isTyping: false, sender: event.sender });
      }
      return;
    }

    if (kind === "channel_mode") {
      const state = parseModerationStatePayload(payloadText);
      if (state) this.opts.onModeChange?.(state);
      return;
    }

    // Targeted at exactly this connection — the gateway closes the
    // underlying socket right after sending this, so there is no reconnect
    // to consider, same terminal handling as "end"/"claimed_elsewhere".
    if (kind === "channel_kicked") {
      this.opts.onKicked?.(parseKickedPayload(payloadText));
      this.opts.onStatusChange("closed");
      this.opts.onTyping({ isTyping: false });
    }
  }

  send(text: string, sender: string): EphemeralTextEvent {
    const { event, payloadText } = buildTextFramePayload(this.opts.symKey, sender, text);
    this.opts.sendFrame("text", payloadText);
    this.markActivity();
    return event;
  }

  sendReaction(msgId: string, emoji: string | null) {
    this.encryptAndSend("react", { msgId, emoji });
  }

  editMessage(msgId: string, text: string): EphemeralEditEvent {
    const event: EphemeralEditEvent = { msgId, text, editedAt: Date.now() };
    this.encryptAndSend("edit", event);
    return event;
  }

  removeMessage(msgId: string): EphemeralRemoveEvent {
    const event: EphemeralRemoveEvent = { msgId, removedAt: Date.now() };
    this.encryptAndSend("remove", event);
    return event;
  }

  // public_group only — announces this participant's nickname to every
  // other live subscriber of the channel (see RELAY_CHANNEL_JOIN's proto
  // comment) so they can add it to their participants list without waiting
  // for a message. Plaintext, not encrypted — presence, not content, same
  // as sendTyping below. Callers are expected to call this once right
  // after joining/rejoining a channel; 1:1 rooms never call this.
  //
  // previousSender, when passed, is this same participant's prior
  // announced name (a mid-session nickname change, not a fresh join) —
  // lets onParticipantJoin subscribers replace the stale entry instead of
  // appending a duplicate, since the roster has no identity beyond the
  // name string itself.
  announcePresence(sender: string, previousSender?: string) {
    this.opts.sendFrame(
      "channel_join",
      JSON.stringify(previousSender ? { sender, previousSender } : { sender })
    );
  }

  // sender: public_group only — this participant's own nickname, so peers
  // can attribute the signal to someone in a channel with more than one
  // other party. Omitted by 1:1 callers, which have exactly one other side
  // to attribute it to.
  sendTyping(isTyping: boolean, sender?: string) {
    if (isTyping) {
      if (this.typingTimeout) {
        clearTimeout(this.typingTimeout);
      } else {
        this.opts.sendFrame("typing", JSON.stringify(sender ? { isTyping: true, sender } : { isTyping: true }));
        this.markActivity();
      }

      this.typingTimeout = setTimeout(() => this.clearTyping(sender), 3000);
      return;
    }

    this.clearTyping(sender);
  }

  private clearTyping(sender?: string) {
    if (!this.typingTimeout) return;

    clearTimeout(this.typingTimeout);
    this.typingTimeout = null;
    this.opts.sendFrame("typing", JSON.stringify(sender ? { isTyping: false, sender } : { isTyping: false }));
    this.markActivity();
  }

  // Either side may call this — the gateway honors it from whoever
  // currently holds either of the room's two slots (see the gateway's
  // ephemeralRoomRegistry.ts's endRoom). Bare control frame, same as
  // "joined"/"left" carrying no encrypted payload.
  end() {
    this.opts.sendFrame("end", "");
  }
}
