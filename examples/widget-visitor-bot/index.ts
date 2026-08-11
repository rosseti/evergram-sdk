import { join } from "node:path";
import { bytesToHex, EvergramBot, hexToBytes } from "../../src/index.js";
import { loadOrCreateIdentity } from "../_shared/load-identity.js";
import { logBotError } from "../_shared/log-error.js";
import {
  loadPersistedVisitorSessions,
  removePersistedVisitorSession,
  savePersistedVisitorSession,
} from "../_shared/visitor-session-store.js";

const GATEWAY_URL = process.env.EVERGRAM_GATEWAY_URL || "ws://localhost:9000/api/ws";
const WEBAPP_URL = process.env.EVERGRAM_WEBAPP_URL || "http://localhost:3000";
const SESSIONS_PATH = join(__dirname, "visitor-sessions.json");

// Echoes back whatever an anonymous widget visitor sends; exercises the
// widget-visitor flow end to end without needing a second human/admin
// device. Open {WEBAPP_URL}/widget/{widgetId} (printed below) in a browser
// to act as the visitor. For a no-browser simulation of the visitor side,
// see sdk/test/integration/visitor-chat.test.ts; by protocol design a
// visitor is never authenticated, so there's no SDK-level client for that
// role to use here.
async function main() {
  const { wallet, device } = loadOrCreateIdentity(join(__dirname, "identity.json"));

  const bot = new EvergramBot({ url: GATEWAY_URL, wallet, device, name: "VisitorEchoBot" });

  // Rehydrate rooms this process was a party to before a restart; see
  // EvergramCore.registerVisitorSession's doc comment. Must run before
  // bot.start(): resyncVisitorSessions (right after auth) is what actually
  // reclaims each room's joiner slot from the gateway, the same way a bare
  // transport reconnect already does for rooms that survive in memory.
  for (const session of loadPersistedVisitorSessions(SESSIONS_PATH)) {
    bot.core.registerVisitorSession({ ...session, symKey: hexToBytes(session.symKeyHex) });
  }

  bot.core.on("disconnected", () => console.warn("[visitor-bot] disconnected from gateway"));
  bot.core.on("reconnecting", (attempt) =>
    console.warn(`[visitor-bot] reconnecting (attempt ${attempt})`),
  );
  bot.core.on("authenticated", () => console.log("[visitor-bot] (re)authenticated"));

  // Persist newly-arrived rooms so a restart can reclaim them later (see
  // above); drop them once they're actually over: either end()ed, or this
  // process lost a join/reclaim race to another device of this same
  // identity (e.g. a browser tab also logged in as the widget owner), in
  // which case that other device keeps the conversation and this one just
  // gives up cleanly instead of silently never seeing it again.
  bot.core.on("visitorRoomRequested", (event) => {
    savePersistedVisitorSession(SESSIONS_PATH, {
      roomToken: event.roomToken,
      symKeyHex: bytesToHex(event.symKey),
      widgetId: event.widgetId,
      visitorLabel: event.visitorLabel,
      origin: event.origin,
    });
  });

  bot.core.on("visitorStatusChanged", ({ roomToken, status }) => {
    if (status !== "closed") return;
    removePersistedVisitorSession(SESSIONS_PATH, roomToken);
    console.warn(`[visitor-bot] room ${roomToken} closed (ended, or claimed by another device)`);
  });

  bot.onVisitorRoomRequested((handle, firstMessage) => {
    console.log(
      `[visitor-bot] room ${handle.roomToken} opened by "${handle.visitorLabel}" from ${handle.origin}`,
    );
    if (firstMessage?.text) {
      console.log(`[visitor-bot] ${handle.visitorLabel} -> ${firstMessage.text}`);
      handle.reply(`Echo: ${firstMessage.text}`);
    }
  });

  bot.onVisitorMessage((msg, handle) => {
    if (!handle) return; // room already closed/expired server-side
    console.log(`[visitor-bot] ${handle.visitorLabel} -> ${msg.text}`);
    handle.reply(`Echo: ${msg.text}`);
  });

  bot.onVisitorRoomTimedOut(({ roomToken }) => {
    console.warn(`[visitor-bot] room ${roomToken} timed out waiting for this bot to join`);
  });

  await bot.start();
  // Registered only after a successful start: a failure during start()
  // already rejects the promise above (see main().catch below), so an
  // "error" listener attached earlier would log that same failure twice.
  bot.core.on("error", (err) => logBotError("[visitor-bot] error:", err));
  console.log(`[visitor-bot] online as ${wallet.address}`);

  // Assumes a widget already exists for this identity (create one at
  // {WEBAPP_URL}/app/widgets, logged in as this same wallet); this example
  // only listens, it doesn't mint one for you.
  const { widgets } = await bot.core.listWidgets();
  const widget = widgets.find((w) => !w.deleted);
  if (!widget) {
    throw new Error(
      `No widget found for ${wallet.address}. Create one first at ${WEBAPP_URL}/app/widgets`,
    );
  }

  console.log(`[visitor-bot] widget "${widget.name}" ready (id ${widget.widgetId})`);
  console.log(`[visitor-bot] open this as a visitor: ${WEBAPP_URL}/widget/${widget.widgetId}`);
}

main().catch((err) => {
  logBotError("[visitor-bot] fatal:", err);
  process.exit(1);
});
