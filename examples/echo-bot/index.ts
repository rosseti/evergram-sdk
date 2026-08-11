import { join } from "node:path";
import { EvergramBot } from "../../src/index.js";
import { loadOrCreateIdentity } from "../_shared/load-identity.js";
import { logBotError } from "../_shared/log-error.js";

const GATEWAY_URL = process.env.EVERGRAM_GATEWAY_URL || "ws://localhost:9000/api/ws";

async function main() {
  const { wallet, device } = loadOrCreateIdentity(join(__dirname, "identity.json"));

  const bot = new EvergramBot({ url: GATEWAY_URL, wallet, device, name: "EchoBot :)" });

  bot.core.on("restricted", (event) =>
    console.warn("[echo-bot] account restricted:", event.reason),
  );
  bot.core.on("chatKeyRotated", ({ chatId }) =>
    console.log(`[echo-bot] chat ${chatId} key rotated`),
  );

  // Core reconnects and re-authenticates on its own after a dropped
  // connection (gateway restart, network blip); see Transport's backoff.
  // None of that is visible unless you listen for it: without these, a
  // gateway outage looks identical to "everything is fine and silent."
  bot.core.on("disconnected", () => console.warn("[echo-bot] disconnected from gateway"));
  bot.core.on("reconnecting", (attempt) =>
    console.warn(`[echo-bot] reconnecting (attempt ${attempt})`),
  );
  bot.core.on("authenticated", () => console.log("[echo-bot] (re)authenticated"));

  bot.onMessage(async (msg, chat) => {
    if (!chat) return; // chat metadata not synced yet
    if (msg.content.type !== "text") return; // skip audio/payment envelopes; nothing sensible to echo
    if (!msg.content.text) return; // decryption failed or empty message

    console.log(`[echo-bot] ${msg.sender} -> ${msg.content.text}`);
    await bot.reply(msg, `Echo: ${msg.content.text}`);
  });

  await bot.start();
  // Registered only after a successful start: a failure during start()
  // already rejects the promise above (see main().catch below), so an
  // "error" listener attached earlier would log that same failure twice.
  bot.core.on("error", (err) => logBotError("[echo-bot] error:", err));
  console.log(`[echo-bot] online as ${wallet.address}`);
}

main().catch((err) => {
  logBotError("[echo-bot] fatal:", err);
  process.exit(1);
});
