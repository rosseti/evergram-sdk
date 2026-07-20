import { join } from "node:path";
import { EvergramBot } from "../../src/index.js";
import { loadOrCreateIdentity } from "../_shared/load-identity.js";

const GATEWAY_URL = process.env.EVERGRAM_GATEWAY_URL || "ws://localhost:9000/api/ws";
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!WEBHOOK_URL) {
  console.error("[webhook-bridge] WEBHOOK_URL env var is required");
  process.exit(1);
}

// Forwards every decrypted message this bot's account is part of to an
// external HTTP endpoint — the bridge between Evergram and systems outside
// the protocol (a support queue, a logging pipeline, a Slack relay, etc).
// The webhook receives plaintext, so whatever runs at WEBHOOK_URL must be
// trusted with the same content the bot itself can read.
async function main() {
  const { wallet, device } = loadOrCreateIdentity(join(__dirname, "identity.json"));

  const bot = new EvergramBot({ url: GATEWAY_URL, wallet, device });
  bot.core.on("error", (err) => console.error("[webhook-bridge] error:", err));
  bot.core.on("disconnected", () => console.warn("[webhook-bridge] disconnected from gateway"));
  bot.core.on("reconnecting", (attempt) =>
    console.warn(`[webhook-bridge] reconnecting (attempt ${attempt})`),
  );
  bot.core.on("authenticated", () => console.log("[webhook-bridge] (re)authenticated"));

  bot.onMessage(async (msg, chat) => {
    if (!msg.text) return;

    try {
      const res = await fetch(WEBHOOK_URL!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chatId: msg.chatId,
          chatName: chat?.meta?.name,
          sender: msg.sender,
          text: msg.text,
          content: msg.content,
          ts: msg.ts,
        }),
      });

      if (!res.ok) {
        console.error(`[webhook-bridge] webhook returned ${res.status}`);
      }
    } catch (err) {
      console.error("[webhook-bridge] webhook delivery failed:", err);
    }
  });

  await bot.start();
  console.log(`[webhook-bridge] online as ${wallet.address}, forwarding to ${WEBHOOK_URL}`);
}

main().catch((err) => {
  console.error("[webhook-bridge] fatal:", err);
  process.exit(1);
});
