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

  onMessage(handler: MessageHandler): () => void {
    const wrapped = (msg: EvergramChatMessage) => {
      Promise.resolve(handler(msg, this.core.getChat(msg.chatId))).catch((err) =>
        this.core.emit("error", err)
      );
    };
    this.core.on("message", wrapped);
    return () => this.core.off("message", wrapped);
  }

  onReaction(handler: ReactionHandler): () => void {
    const wrapped = (reaction: EvergramReaction) => {
      Promise.resolve(handler(reaction, this.core.getChat(reaction.chatId))).catch((err) =>
        this.core.emit("error", err)
      );
    };
    this.core.on("reaction", wrapped);
    return () => this.core.off("reaction", wrapped);
  }

  onMessageEdited(handler: MessageEditedHandler): () => void {
    const wrapped = (edit: EvergramMessageEdited) => {
      Promise.resolve(handler(edit, this.core.getChat(edit.chatId))).catch((err) =>
        this.core.emit("error", err)
      );
    };
    this.core.on("messageEdited", wrapped);
    return () => this.core.off("messageEdited", wrapped);
  }

  onMessageDeleted(handler: MessageDeletedHandler): () => void {
    const wrapped = (deletion: EvergramMessageDeleted) => {
      Promise.resolve(handler(deletion, this.core.getChat(deletion.chatId))).catch((err) =>
        this.core.emit("error", err)
      );
    };
    this.core.on("messageDeleted", wrapped);
    return () => this.core.off("messageDeleted", wrapped);
  }

  onJoinRequest(handler: JoinRequestHandler): () => void {
    const wrapped = (event: JoinRequestedEvent) => {
      const req: JoinRequestHandle = {
        ...event,
        approve: () => this.core.addParticipant(event.chatId, event.identity),
        deny: () => this.core.denyJoinRequest(event.chatId, event.identity),
      };

      Promise.resolve(handler(req)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("joinRequested", wrapped);
    return () => this.core.off("joinRequested", wrapped);
  }

  // Fires when another identity tries to start a 1:1 chat with this bot
  // while requireChatApproval is enabled (see core.updatePrivacySettings).
  // Also covers requests already pending at connect time, replayed from
  // queryChatsResponse — handlers registered before start() see those too.
  onChatRequest(handler: ChatRequestHandler): () => void {
    const wrapped = (event: PendingChatRequest) => {
      const req: ChatRequestHandle = {
        ...event,
        approve: () => this.core.acceptChatRequest(event.fromIdentity),
        deny: () => this.core.blockIdentity(event.fromIdentity),
      };

      Promise.resolve(handler(req)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("chatRequestReceived", wrapped);

    for (const req of this.core.getPendingChatRequests()) {
      wrapped(req);
    }

    return () => this.core.off("chatRequestReceived", wrapped);
  }

  // Fires when an admin tries to add this bot to a group while
  // requireChatApproval is enabled. Also covers invites already pending at
  // connect time, replayed from queryChatsResponse.
  onGroupInvite(handler: GroupInviteHandler): () => void {
    const wrapped = (event: PendingGroupInvite) => {
      const req: GroupInviteHandle = {
        ...event,
        approve: () => this.core.acceptGroupInvite(event.chatId),
        deny: () => this.core.declineGroupInvite(event.chatId),
      };

      Promise.resolve(handler(req)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("groupInviteReceived", wrapped);

    for (const req of this.core.getPendingGroupInvites()) {
      wrapped(req);
    }

    return () => this.core.off("groupInviteReceived", wrapped);
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
    const wrapped = (event: EvergramVisitorRoomRequested) => {
      const handle = buildVisitorSessionHandle(this.core, event);
      Promise.resolve(handler(handle, event.firstMessage)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("visitorRoomRequested", wrapped);
    return () => this.core.off("visitorRoomRequested", wrapped);
  }

  onVisitorMessage(handler: VisitorMessageHandler): () => void {
    const wrapped = (msg: EvergramVisitorMessage) => {
      const meta = this.core.getVisitorSession(msg.roomToken);
      const handle = meta ? buildVisitorSessionHandle(this.core, { roomToken: msg.roomToken, ...meta }) : undefined;
      Promise.resolve(handler(msg, handle)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("visitorMessage", wrapped);
    return () => this.core.off("visitorMessage", wrapped);
  }

  onVisitorReaction(handler: VisitorReactionHandler): () => void {
    const wrapped = (reaction: EvergramVisitorReaction) => {
      const meta = this.core.getVisitorSession(reaction.roomToken);
      const handle = meta ? buildVisitorSessionHandle(this.core, { roomToken: reaction.roomToken, ...meta }) : undefined;
      Promise.resolve(handler(reaction, handle)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("visitorReaction", wrapped);
    return () => this.core.off("visitorReaction", wrapped);
  }

  onVisitorMessageEdited(handler: VisitorMessageEditedHandler): () => void {
    const wrapped = (edit: EvergramVisitorMessageEdited) => {
      const meta = this.core.getVisitorSession(edit.roomToken);
      const handle = meta ? buildVisitorSessionHandle(this.core, { roomToken: edit.roomToken, ...meta }) : undefined;
      Promise.resolve(handler(edit, handle)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("visitorMessageEdited", wrapped);
    return () => this.core.off("visitorMessageEdited", wrapped);
  }

  onVisitorMessageDeleted(handler: VisitorMessageDeletedHandler): () => void {
    const wrapped = (deletion: EvergramVisitorMessageDeleted) => {
      const meta = this.core.getVisitorSession(deletion.roomToken);
      const handle = meta ? buildVisitorSessionHandle(this.core, { roomToken: deletion.roomToken, ...meta }) : undefined;
      Promise.resolve(handler(deletion, handle)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("visitorMessageDeleted", wrapped);
    return () => this.core.off("visitorMessageDeleted", wrapped);
  }

  onVisitorTyping(handler: VisitorTypingHandler): () => void {
    const wrapped = (event: EvergramVisitorTyping) => {
      const meta = this.core.getVisitorSession(event.roomToken);
      const handle = meta ? buildVisitorSessionHandle(this.core, { roomToken: event.roomToken, ...meta }) : undefined;
      Promise.resolve(handler(event, handle)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("visitorTyping", wrapped);
    return () => this.core.off("visitorTyping", wrapped);
  }

  // public_group only — fires when another participant announces itself
  // (a fresh join) or renames mid-session. See EvergramVisitorChannelParticipantJoined.
  onVisitorChannelParticipantJoined(handler: VisitorChannelParticipantJoinedHandler): () => void {
    const wrapped = (event: EvergramVisitorChannelParticipantJoined) => {
      const meta = this.core.getVisitorSession(event.roomToken);
      const handle = meta ? buildVisitorSessionHandle(this.core, { roomToken: event.roomToken, ...meta }) : undefined;
      Promise.resolve(handler(event, handle)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("visitorChannelParticipantJoined", wrapped);
    return () => this.core.off("visitorChannelParticipantJoined", wrapped);
  }

  // public_group only — fires when a channel participant disconnects.
  onVisitorChannelParticipantLeft(handler: VisitorChannelParticipantLeftHandler): () => void {
    const wrapped = (event: EvergramVisitorChannelParticipantLeft) => {
      const meta = this.core.getVisitorSession(event.roomToken);
      const handle = meta ? buildVisitorSessionHandle(this.core, { roomToken: event.roomToken, ...meta }) : undefined;
      Promise.resolve(handler(event, handle)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("visitorChannelParticipantLeft", wrapped);
    return () => this.core.off("visitorChannelParticipantLeft", wrapped);
  }

  // public_group only — fires whenever a moderateChannel() action (by this
  // bot or another op) changes the channel's moderated flag or op/voice roster.
  onVisitorChannelModeChanged(handler: VisitorChannelModeChangedHandler): () => void {
    const wrapped = (event: EvergramVisitorChannelModeChanged) => {
      const meta = this.core.getVisitorSession(event.roomToken);
      const handle = meta ? buildVisitorSessionHandle(this.core, { roomToken: event.roomToken, ...meta }) : undefined;
      Promise.resolve(handler(event, handle)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("visitorChannelModeChanged", wrapped);
    return () => this.core.off("visitorChannelModeChanged", wrapped);
  }

  // public_group only — fires when this bot's own channel subscription was
  // kicked or banned. No handle is passed: the session is already torn down
  // by the time this fires (see core.ts's createVisitorSession onStatusChange).
  onVisitorKicked(handler: VisitorKickedHandler): () => void {
    const wrapped = (event: EvergramVisitorKicked) => {
      Promise.resolve(handler(event)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("visitorKicked", wrapped);
    return () => this.core.off("visitorKicked", wrapped);
  }

  // Fires only in the rarer race where the widget owner had a device
  // online at room-creation time but it disconnected before ever joining
  // — the common "no device online" case is rejected synchronously to the
  // visitor and this bot never even hears about that conversation.
  onVisitorRoomTimedOut(handler: VisitorRoomTimedOutHandler): () => void {
    const wrapped = (event: EvergramVisitorRoomTimedOut) => {
      Promise.resolve(handler(event)).catch((err) => this.core.emit("error", err));
    };

    this.core.on("visitorRoomTimedOut", wrapped);
    return () => this.core.off("visitorRoomTimedOut", wrapped);
  }
}
