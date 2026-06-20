import { EvergramChatMessage, EvergramCore, EvergramCoreOptions } from "./core";
import { ChatInfo, JoinRequestedEvent } from "./proto/evergram";
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

type MessageHandler = (msg: EvergramChatMessage, chat: ChatInfo | undefined) => void | Promise<void>;
type JoinRequestHandler = (req: JoinRequestHandle) => void | Promise<void>;

export interface EvergramBotOptions extends EvergramCoreOptions {
  /**
   * Display name for this bot. If set, `start()` calls
   * `core.setProfile({ nickname: name })` right after connecting, so chat
   * UIs show this instead of a raw address. Re-applied on every start() —
   * harmless (setProfile has no rate limit of its own) but worth knowing if
   * you're restarting frequently in a tight loop.
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

    if (this.name) {
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

  reply(msg: EvergramChatMessage, text: string) {
    return this.core.sendMessage(msg.chatId, text);
  }
}
