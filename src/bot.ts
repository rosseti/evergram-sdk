import {
  EvergramChatMessage,
  EvergramCore,
  EvergramCoreOptions,
  EvergramMessageDeleted,
  EvergramMessageEdited,
  EvergramReaction,
  EvergramVisitorChannelModeChanged,
  EvergramVisitorChannelParticipantJoined,
  EvergramVisitorChannelParticipantLeft,
  EvergramVisitorKicked,
  EvergramVisitorMessage,
  EvergramVisitorMessageDeleted,
  EvergramVisitorMessageEdited,
  EvergramVisitorReaction,
  EvergramVisitorRoomRequested,
  EvergramVisitorRoomTimedOut,
  EvergramVisitorTyping,
} from "./core";
import { ChatInfo, JoinRequestedEvent, ModerationAction, PendingChatRequest, PendingGroupInvite } from "./proto/evergram";
import { EphemeralEditEvent, EphemeralRemoveEvent, EphemeralTextEvent } from "./ephemeral-relay-session";

export interface JoinRequestHandle extends JoinRequestedEvent {
  /** Adds the requester as a participant. */
  approve(): Promise<unknown>;
  /** Removes the requester from pendingJoinRequests without adding them. */
  deny(): Promise<unknown>;
}

export interface ChatRequestHandle extends PendingChatRequest {
  /** Accepts the request and materializes the 1:1 chat (acceptChatRequest). */
  approve(): Promise<unknown>;
  /** Rejects the request — clears it without ever creating a chat (blockIdentity). */
  deny(): Promise<unknown>;
}

export interface GroupInviteHandle extends PendingGroupInvite {
  /** Accepts the invite and joins the group (acceptGroupInvite). */
  approve(): Promise<unknown>;
  /** Declines this one invite only — does not block the inviter (declineGroupInvite). */
  deny(): Promise<unknown>;
}

// Widget-visitor chat — see [[evergram-sdk-relay-duplication]] memory.
// Unlike JoinRequestHandle/ChatRequestHandle/GroupInviteHandle (one-shot
// approve/deny), a visitor conversation is ongoing — this Handle is handed
// to every onVisitor* callback for the same roomToken so a bot can keep
// acting on it across the whole exchange, not just the opening request.
export interface VisitorSessionHandle {
  roomToken: string;
  widgetId: string;
  visitorLabel: string;
  origin: string;
  /** Reply in this conversation. sender defaults to this bot's own profile nickname. */
  reply(text: string, sender?: string): EphemeralTextEvent;
  react(msgId: string, emoji: string | null): void;
  edit(msgId: string, text: string): EphemeralEditEvent;
  remove(msgId: string): EphemeralRemoveEvent;
  /** Signals (or clears) "agent is typing" to the visitor — mirrors the real chat's sendTyping. */
  typing(isTyping: boolean): void;
  /** Permanently ends the conversation — the visitor can't reconnect into it afterward. */
  end(): void;
  /**
   * public_group only — announces this bot's nickname to the channel's
   * roster. Call once after subscribing, and again on any later rename.
   * No-op-shaped for 1:1 rooms (the gateway simply never has anyone to
   * broadcast it to), but there's no reason to call it there.
   */
  announcePresence(sender: string, previousSender?: string): void;
  /**
   * public_group only — kick/ban/unban/op/voice/moderated toggle. Requires
   * this bot to currently be a channel op (always true for the widget's own
   * owner — see subscribePublicChannel's auto-op). Throws via the response
   * status on the wire, same as every other RPC — this does not pre-check
   * authorization client-side.
   */
  moderate(action: ModerationAction, targetParticipant?: string): Promise<unknown>;
}

function buildVisitorSessionHandle(
  core: EvergramCore,
  meta: { roomToken: string; widgetId: string; visitorLabel: string; origin: string }
): VisitorSessionHandle {
  return {
    ...meta,
    reply: (text, sender) => core.sendVisitorMessage(meta.roomToken, text, sender),
    react: (msgId, emoji) => core.reactToVisitorMessage(meta.roomToken, msgId, emoji),
    edit: (msgId, text) => core.editVisitorMessage(meta.roomToken, msgId, text),
    remove: (msgId) => core.removeVisitorMessage(meta.roomToken, msgId),
    typing: (isTyping) => core.sendVisitorTyping(meta.roomToken, isTyping),
    end: () => core.endVisitorRoom(meta.roomToken),
    announcePresence: (sender, previousSender) => core.announceChannelPresence(meta.roomToken, sender, previousSender),
    moderate: (action, targetParticipant) => core.moderateChannel(meta.roomToken, action, targetParticipant),
  };
}

type MessageHandler = (msg: EvergramChatMessage, chat: ChatInfo | undefined) => void | Promise<void>;
type ReactionHandler = (reaction: EvergramReaction, chat: ChatInfo | undefined) => void | Promise<void>;
type MessageEditedHandler = (edit: EvergramMessageEdited, chat: ChatInfo | undefined) => void | Promise<void>;
type MessageDeletedHandler = (deletion: EvergramMessageDeleted, chat: ChatInfo | undefined) => void | Promise<void>;
type VisitorRoomRequestedHandler = (
  handle: VisitorSessionHandle,
  firstMessage: EphemeralTextEvent | null
) => void | Promise<void>;
type VisitorMessageHandler = (msg: EvergramVisitorMessage, handle: VisitorSessionHandle | undefined) => void | Promise<void>;
type VisitorReactionHandler = (reaction: EvergramVisitorReaction, handle: VisitorSessionHandle | undefined) => void | Promise<void>;
type VisitorMessageEditedHandler = (
  edit: EvergramVisitorMessageEdited,
  handle: VisitorSessionHandle | undefined
) => void | Promise<void>;
type VisitorMessageDeletedHandler = (
  deletion: EvergramVisitorMessageDeleted,
  handle: VisitorSessionHandle | undefined
) => void | Promise<void>;
type VisitorTypingHandler = (event: EvergramVisitorTyping, handle: VisitorSessionHandle | undefined) => void | Promise<void>;
type VisitorRoomTimedOutHandler = (event: EvergramVisitorRoomTimedOut) => void | Promise<void>;
type VisitorChannelParticipantJoinedHandler = (
  event: EvergramVisitorChannelParticipantJoined,
  handle: VisitorSessionHandle | undefined
) => void | Promise<void>;
type VisitorChannelParticipantLeftHandler = (
  event: EvergramVisitorChannelParticipantLeft,
  handle: VisitorSessionHandle | undefined
) => void | Promise<void>;
type VisitorChannelModeChangedHandler = (
  event: EvergramVisitorChannelModeChanged,
  handle: VisitorSessionHandle | undefined
) => void | Promise<void>;
type VisitorKickedHandler = (event: EvergramVisitorKicked) => void | Promise<void>;
type JoinRequestHandler = (req: JoinRequestHandle) => void | Promise<void>;
type ChatRequestHandler = (req: ChatRequestHandle) => void | Promise<void>;
type GroupInviteHandler = (req: GroupInviteHandle) => void | Promise<void>;

export interface EvergramBotOptions extends EvergramCoreOptions {
  /**
   * Display name for this bot. If set, `start()` calls
   * `core.setProfile({ nickname: name })` right after connecting, so chat
   * UIs show this instead of a raw address. Skipped if the nickname
   * authResponse already reported back is already `name` — setProfile is a
   * contract write (a full consensus round trip), so re-applying an
   * unchanged nickname on every start/reconnect would just be wasted
   * latency on the common case of a bot restarting with the same name.
   */
  name?: string;
}

// Ergonomic wrapper over EvergramCore, modeled on Telegraf/Discord.js-style
// bot frameworks. Reconnection, re-authentication, mailbox delivery and key
// rotation are all handled transparently by Core — this layer is purely
// about reading naturally for bot business logic. Use `bot.core` directly
// for anything not covered here (it's the same 1:1 protocol surface).
export class EvergramBot {
  readonly core: EvergramCore;
  private readonly name?: string;

  constructor(opts: EvergramBotOptions) {
    this.core = new EvergramCore(opts);
    this.name = opts.name;
  }

  async start(): Promise<void> {
    await this.core.connect();

    if (this.name && this.core.profile?.nickname !== this.name) {
      await this.core.setProfile({ nickname: this.name });
    }
  }

  stop(): void {
    this.core.close();
  }

  // Every onX below follows the same shape: subscribe to a core event,
  // run the handler, and route a rejected/thrown handler into the core's
  // "error" event instead of an unhandled rejection — so bot authors never
  // need their own try/catch just to keep one bad handler from crashing the
  // process. bindEvent centralizes that plumbing; each onX only supplies
  // what's specific to its event (context lookup, unsubscribe wiring).
  private bindEvent<TArg>(event: string, run: (arg: TArg) => void | Promise<void>): () => void {
    const wrapped = (arg: TArg) => {
      Promise.resolve(run(arg)).catch((err) => this.core.emit("error", err));
    };
    // Cast needed here only: EvergramCore's on/off are typed per-event (see
    // EvergramCoreEvents in core.ts) for external callers, but this helper is
    // intentionally generic over any of that emitter's event names — each
    // onX call site above still supplies the correct TArg for its event.
    const core = this.core as unknown as { on(e: string, l: (arg: TArg) => void): void; off(e: string, l: (arg: TArg) => void): void };
    core.on(event, wrapped);
    return () => core.off(event, wrapped);
  }

  // Same as bindEvent, but for visitor events: resolves the VisitorSessionHandle
  // for the event's roomToken (or undefined if the session already ended)
  // before invoking the handler — every onVisitorX callback needs this.
  private bindVisitorEvent<TArg extends { roomToken: string }>(
    event: string,
    handler: (arg: TArg, handle: VisitorSessionHandle | undefined) => void | Promise<void>
  ): () => void {
    return this.bindEvent<TArg>(event, (arg) => {
      const meta = this.core.getVisitorSession(arg.roomToken);
      const handle = meta ? buildVisitorSessionHandle(this.core, { roomToken: arg.roomToken, ...meta }) : undefined;
      return handler(arg, handle);
    });
  }

  onMessage(handler: MessageHandler): () => void {
    return this.bindEvent<EvergramChatMessage>("message", (msg) => handler(msg, this.core.getChat(msg.chatId)));
  }

  onReaction(handler: ReactionHandler): () => void {
    return this.bindEvent<EvergramReaction>("reaction", (reaction) =>
      handler(reaction, this.core.getChat(reaction.chatId))
    );
  }

  onMessageEdited(handler: MessageEditedHandler): () => void {
    return this.bindEvent<EvergramMessageEdited>("messageEdited", (edit) =>
      handler(edit, this.core.getChat(edit.chatId))
    );
  }

  onMessageDeleted(handler: MessageDeletedHandler): () => void {
    return this.bindEvent<EvergramMessageDeleted>("messageDeleted", (deletion) =>
      handler(deletion, this.core.getChat(deletion.chatId))
    );
  }

  onJoinRequest(handler: JoinRequestHandler): () => void {
    return this.bindEvent<JoinRequestedEvent>("joinRequested", (event) =>
      handler({
        ...event,
        approve: () => this.core.addParticipant(event.chatId, event.identity),
        deny: () => this.core.denyJoinRequest(event.chatId, event.identity),
      })
    );
  }

  // Fires when another identity tries to start a 1:1 chat with this bot
  // while requireChatApproval is enabled (see core.updatePrivacySettings).
  // Also covers requests already pending at connect time, replayed from
  // queryChatsResponse — handlers registered before start() see those too.
  onChatRequest(handler: ChatRequestHandler): () => void {
    const asHandle = (event: PendingChatRequest): ChatRequestHandle => ({
      ...event,
      approve: () => this.core.acceptChatRequest(event.fromIdentity),
      deny: () => this.core.blockIdentity(event.fromIdentity),
    });

    const unsubscribe = this.bindEvent<PendingChatRequest>("chatRequestReceived", (event) => handler(asHandle(event)));

    for (const req of this.core.getPendingChatRequests()) {
      Promise.resolve(handler(asHandle(req))).catch((err) => this.core.emit("error", err));
    }

    return unsubscribe;
  }

  // Fires when an admin tries to add this bot to a group while
  // requireChatApproval is enabled. Also covers invites already pending at
  // connect time, replayed from queryChatsResponse.
  onGroupInvite(handler: GroupInviteHandler): () => void {
    const asHandle = (event: PendingGroupInvite): GroupInviteHandle => ({
      ...event,
      approve: () => this.core.acceptGroupInvite(event.chatId),
      deny: () => this.core.declineGroupInvite(event.chatId),
    });

    const unsubscribe = this.bindEvent<PendingGroupInvite>("groupInviteReceived", (event) => handler(asHandle(event)));

    for (const req of this.core.getPendingGroupInvites()) {
      Promise.resolve(handler(asHandle(req))).catch((err) => this.core.emit("error", err));
    }

    return unsubscribe;
  }

  reply(msg: EvergramChatMessage, text: string) {
    return this.core.sendMessage(msg.chatId, text);
  }

  // Fires once per anonymous widget visitor conversation, when they send
  // their opening message. No replay-at-registration-time (unlike
  // onChatRequest/onGroupInvite): visitor rooms have no contract-side
  // "pending" list — a request missed while this bot was offline is
  // simply gone, same as the webapp's behavior today.
  onVisitorRoomRequested(handler: VisitorRoomRequestedHandler): () => void {
    return this.bindEvent<EvergramVisitorRoomRequested>("visitorRoomRequested", (event) =>
      handler(buildVisitorSessionHandle(this.core, event), event.firstMessage)
    );
  }

  onVisitorMessage(handler: VisitorMessageHandler): () => void {
    return this.bindVisitorEvent<EvergramVisitorMessage>("visitorMessage", handler);
  }

  onVisitorReaction(handler: VisitorReactionHandler): () => void {
    return this.bindVisitorEvent<EvergramVisitorReaction>("visitorReaction", handler);
  }

  onVisitorMessageEdited(handler: VisitorMessageEditedHandler): () => void {
    return this.bindVisitorEvent<EvergramVisitorMessageEdited>("visitorMessageEdited", handler);
  }

  onVisitorMessageDeleted(handler: VisitorMessageDeletedHandler): () => void {
    return this.bindVisitorEvent<EvergramVisitorMessageDeleted>("visitorMessageDeleted", handler);
  }

  onVisitorTyping(handler: VisitorTypingHandler): () => void {
    return this.bindVisitorEvent<EvergramVisitorTyping>("visitorTyping", handler);
  }

  // public_group only — fires when another participant announces itself
  // (a fresh join) or renames mid-session. See EvergramVisitorChannelParticipantJoined.
  onVisitorChannelParticipantJoined(handler: VisitorChannelParticipantJoinedHandler): () => void {
    return this.bindVisitorEvent<EvergramVisitorChannelParticipantJoined>("visitorChannelParticipantJoined", handler);
  }

  // public_group only — fires when a channel participant disconnects.
  onVisitorChannelParticipantLeft(handler: VisitorChannelParticipantLeftHandler): () => void {
    return this.bindVisitorEvent<EvergramVisitorChannelParticipantLeft>("visitorChannelParticipantLeft", handler);
  }

  // public_group only — fires whenever a moderateChannel() action (by this
  // bot or another op) changes the channel's moderated flag or op/voice roster.
  onVisitorChannelModeChanged(handler: VisitorChannelModeChangedHandler): () => void {
    return this.bindVisitorEvent<EvergramVisitorChannelModeChanged>("visitorChannelModeChanged", handler);
  }

  // public_group only — fires when this bot's own channel subscription was
  // kicked or banned. No handle is passed: the session is already torn down
  // by the time this fires (see core.ts's createVisitorSession onStatusChange).
  onVisitorKicked(handler: VisitorKickedHandler): () => void {
    return this.bindEvent<EvergramVisitorKicked>("visitorKicked", handler);
  }

  // Fires only in the rarer race where the widget owner had a device
  // online at room-creation time but it disconnected before ever joining
  // — the common "no device online" case is rejected synchronously to the
  // visitor and this bot never even hears about that conversation.
  onVisitorRoomTimedOut(handler: VisitorRoomTimedOutHandler): () => void {
    return this.bindEvent<EvergramVisitorRoomTimedOut>("visitorRoomTimedOut", handler);
  }
}
