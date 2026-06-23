import {
  EvergramChatMessage,
  EvergramCore,
  EvergramCoreOptions,
  EvergramMessageDeleted,
  EvergramMessageEdited,
  EvergramReaction,
} from "./core";
import { ChatInfo, JoinRequestedEvent, PendingChatRequest, PendingGroupInvite } from "./proto/evergram";
import { EvergramError } from "./errors";

export interface JoinRequestHandle extends JoinRequestedEvent {
  /** Adds the requester as a participant — the only accept path the protocol exposes today. */
  approve(): Promise<unknown>;
  /**
   * The wire protocol has no reject/deny RPC (see contract's handleAddParticipant:
   * the only way a pendingJoinRequests entry is cleared is by approving it).
   * Calling this always throws — it exists so your bot's branching reads
   * naturally (`if (...) req.approve(); else req.deny();`) instead of
   * silently doing nothing, while making the limitation impossible to miss.
   */
  deny(): never;
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

type MessageHandler = (msg: EvergramChatMessage, chat: ChatInfo | undefined) => void | Promise<void>;
type ReactionHandler = (reaction: EvergramReaction, chat: ChatInfo | undefined) => void | Promise<void>;
type MessageEditedHandler = (edit: EvergramMessageEdited, chat: ChatInfo | undefined) => void | Promise<void>;
type MessageDeletedHandler = (deletion: EvergramMessageDeleted, chat: ChatInfo | undefined) => void | Promise<void>;
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
        deny: () => {
          throw new EvergramError(
            "deny_not_supported",
            "The Evergram protocol has no reject RPC for join requests today — only approve() (addParticipant) clears a pending request."
          );
        },
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
}
