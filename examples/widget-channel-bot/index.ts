import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { EvergramBot, ModerationAction, Widget, WidgetConfig } from "../../src/index.js";
import { loadOrCreateIdentity } from "../_shared/load-identity.js";

const GATEWAY_URL = process.env.EVERGRAM_GATEWAY_URL || "ws://localhost:9000/api/ws";
const WEBAPP_URL = process.env.EVERGRAM_WEBAPP_URL || "http://localhost:3000";
// Parameterizable so this same example can run against any widget you own:
// falls back to "the first non-deleted widget this identity owns" (same
// convention as visitor-bot) when unset.
const WIDGET_ID = process.env.EVERGRAM_WIDGET_ID || "";
const NICKNAME = process.env.EVERGRAM_NICKNAME || "Widget Group Bot";

// Joins this bot into a widget's public_group channel as an operator (auto-
// opped, same as the webapp owner's live-arrival session); echoes channel
// messages and demonstrates moderation via simple slash commands. Unlike
// visitor-bot (which reacts to 1:1 rooms as visitors open them), a channel
// is joined explicitly via subscribePublicChannel() and is shared by every
// visitor currently connected to the widget.
async function main() {
  const { wallet, device } = loadOrCreateIdentity(join(__dirname, "identity.json"));

  const bot = new EvergramBot({ url: GATEWAY_URL, wallet, device, name: NICKNAME });

  bot.core.on("error", (err) => console.error("[channel-bot] error:", err));
  bot.core.on("disconnected", () => console.warn("[channel-bot] disconnected from gateway"));
  bot.core.on("reconnecting", (attempt) =>
    console.warn(`[channel-bot] reconnecting (attempt ${attempt})`),
  );
  bot.core.on("authenticated", () => console.log("[channel-bot] (re)authenticated"));

  bot.core.on("visitorChannelParticipantJoined", ({ sender, previousSender }) => {
    console.log(
      previousSender
        ? `[channel-bot] ${previousSender} is now ${sender}`
        : `[channel-bot] ${sender} joined the channel`,
    );
  });

  bot.core.on("visitorChannelParticipantLeft", ({ sender }) => {
    console.log(`[channel-bot] ${sender} left the channel`);
  });

  bot.core.on("visitorChannelModeChanged", ({ moderated, ops, voiced }) => {
    console.log(
      `[channel-bot] mode: moderated=${moderated} ops=[${ops.join(", ")}] voiced=[${voiced.join(", ")}]`,
    );
  });

  bot.core.on("visitorKicked", ({ reason }) => {
    console.warn(`[channel-bot] this bot was ${reason}; subscription ended`);
  });

  // Channel text arrives through the same "visitorMessage" event 1:1 rooms
  // use (sendVisitorMessage/onVisitorMessage are roomToken-generic; see
  // [[evergram-sdk-relay-duplication]]), so this one handler covers both a
  // plain echo and a tiny slash-command surface for moderation.
  bot.onVisitorMessage(async (msg, handle) => {
    if (!handle) return; // channel already closed (this bot's subscription ended)
    console.log(`[channel-bot] ${msg.sender} -> ${msg.text}`);

    const [command, target] = msg.text.trim().split(/\s+/);
    const actionByCommand: Record<string, ModerationAction> = {
      "/kick": ModerationAction.MODERATION_KICK,
      "/ban": ModerationAction.MODERATION_BAN,
      "/unban": ModerationAction.MODERATION_UNBAN,
      "/op": ModerationAction.MODERATION_GRANT_OP,
      "/deop": ModerationAction.MODERATION_REVOKE_OP,
      "/voice": ModerationAction.MODERATION_GRANT_VOICE,
      "/devoice": ModerationAction.MODERATION_REVOKE_VOICE,
    };

    if (command === "/mod" || command === "/unmod") {
      await handle.moderate(
        command === "/mod"
          ? ModerationAction.MODERATION_SET_MODERATED
          : ModerationAction.MODERATION_UNSET_MODERATED,
      );
      return;
    }

    const action = actionByCommand[command];
    if (action !== undefined && target) {
      const resp = await handle.moderate(action, target);
      if (!(resp as { status?: { ok: boolean } }).status?.ok) {
        handle.reply(
          `Couldn't ${command.slice(1)} ${target}. Are they in the channel and are you an op?`,
        );
      }
      return;
    }

    handle.reply(`Echo: ${msg.text}`);
  });

  await bot.start();
  console.log(`[channel-bot] online as ${wallet.address}`);

  const { widgets } = await bot.core.listWidgets();
  const widget: Widget | undefined = WIDGET_ID
    ? widgets.find((w) => w.widgetId === WIDGET_ID && !w.deleted)
    : widgets.find((w) => !w.deleted);
  if (!widget) {
    throw new Error(
      WIDGET_ID
        ? `Widget ${WIDGET_ID} not found (or deleted) for ${wallet.address}`
        : `No widget found for ${wallet.address}. Create one first at ${WEBAPP_URL}/app/widgets`,
    );
  }

  // Auto-configure the widget into public_group with a fresh channel key if
  // it isn't already set up that way; mirrors the settings page's own
  // "generate a key the first time you switch to Public Channel" behavior,
  // so this example works against a widget that's still in its default
  // private_chat state.
  let channelKeyHex = widget.config?.mode === "public_group" ? widget.config.channelKey : "";
  if (channelKeyHex.length !== 64) {
    channelKeyHex = randomBytes(32).toString("hex");
    const config: WidgetConfig = {
      ...widget.config,
      mode: "public_group",
      channelKey: channelKeyHex,
    } as WidgetConfig;
    await bot.core.updateWidgetConfig(widget.widgetId, config);
    console.log(
      `[channel-bot] widget "${widget.name}" switched to public_group with a fresh channel key`,
    );
  }

  const { status, roomToken, participants } = await bot.core.subscribePublicChannel(
    widget.widgetId,
    channelKeyHex,
  );
  if (!status?.ok || !roomToken) {
    throw new Error(`subscribePublicChannel failed: ${status?.code} ${status?.message}`);
  }

  bot.core.announceChannelPresence(roomToken, NICKNAME);
  console.log(`[channel-bot] joined channel for widget "${widget.name}" (room ${roomToken})`);
  console.log(
    `[channel-bot] current participants: ${participants.length ? participants.join(", ") : "(none yet)"}`,
  );
  console.log(`[channel-bot] open this as a visitor: ${WEBAPP_URL}/widget/${widget.widgetId}`);
}

main().catch((err) => {
  console.error("[channel-bot] fatal:", err);
  process.exit(1);
});
