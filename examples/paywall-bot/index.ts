import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  buildPaymentRequest,
  ChainFamily,
  EvergramAccessDeniedError,
  EvergramBot,
  identityKey,
} from "../../src";
import { loadOrCreateIdentity } from "../_shared/load-identity";

const GATEWAY_URL = process.env.EVERGRAM_GATEWAY_URL || "ws://localhost:9000/api/ws";
const PAYWALL_CHAT_ID = process.env.PAYWALL_CHAT_ID;
const PAYWALL_AMOUNT = process.env.PAYWALL_AMOUNT || "5";
const PAYWALL_CURRENCY = process.env.PAYWALL_CURRENCY || "XAH";
const PAYWALL_CURRENCY_ID = process.env.PAYWALL_CURRENCY_ID || "XAH";

if (!PAYWALL_CHAT_ID) {
  console.error("[paywall-bot] PAYWALL_CHAT_ID env var is required");
  process.exit(1);
}

// Gates membership in PAYWALL_CHAT_ID behind a payment_request/payment_receipt
// handshake (see src/message-content.ts's PaymentRequestContent/PaymentReceiptContent):
// DM the bot, it quotes a price, you reply with a receipt, it calls
// addParticipant(). Like moderation-bot, this needs admin/moderator role on
// PAYWALL_CHAT_ID already — see README "Access tiers".
//
// IMPORTANT: payment_request/payment_receipt are a client-side message
// convention only. Nothing in the gateway or contract verifies a receipt's
// txHash — it's exactly as trustworthy as any other field in a message a
// peer chose to send you. The proto's InitiatePurchase/VerifyPurchase/ClaimPro/
// Subscription messages (src/proto/evergram.ts:838-925) describe a real
// on-chain-verified purchase flow with actual XRPL Hook params, but no
// EvergramCore method wraps them today, so this example can't use them. A
// production paywall must independently verify txHash against the XRPL/Xahau
// ledger (e.g. via the `xrpl` package, already a dependency) for the right
// amount/currency/destination before trusting a receipt — this example
// demonstrates the message plumbing only, not payment verification.
async function main() {
  const { wallet, device } = loadOrCreateIdentity(join(__dirname, "identity.json"));

  const bot = new EvergramBot({ url: GATEWAY_URL, wallet, device, name: "PaywallBot" });
  const selfIdentityKey = identityKey({ chainFamily: ChainFamily.XRPL, address: wallet.address });

  bot.core.on("error", (err) => console.error("[paywall-bot] error:", err));
  bot.core.on("disconnected", () => console.warn("[paywall-bot] disconnected from gateway"));
  bot.core.on("reconnecting", (attempt) => console.warn(`[paywall-bot] reconnecting (attempt ${attempt})`));
  bot.core.on("authenticated", () => console.log("[paywall-bot] (re)authenticated"));

  const verified = new Set<string>(); // identity keys who've paid
  const pendingRequests = new Map<string, string>(); // identity key -> outstanding requestId

  // Sets `pendingRequests` synchronously before the `await` below so two
  // messages arriving back to back from the same sender can't mint two
  // different requestIds and clobber each other.
  function sendPaymentRequest(chatId: string, sender: string) {
    const requestId = randomUUID();
    pendingRequests.set(sender, requestId);

    bot.core
      .sendMessage(
        chatId,
        buildPaymentRequest({
          requestId,
          amount: PAYWALL_AMOUNT,
          currency: PAYWALL_CURRENCY,
          currencyId: PAYWALL_CURRENCY_ID,
          to: wallet.address,
          toIdentityKey: selfIdentityKey,
        })
      )
      .catch((err) => bot.core.emit("error", err));
  }

  bot.onMessage(async (msg) => {
    if (msg.chatId === PAYWALL_CHAT_ID) return; // only react to DMs, not chatter inside the gated group

    const sender = msg.sender;

    if (msg.content.type === "payment_receipt") {
      if (verified.has(sender)) {
        await bot.reply(msg, "You're already in — no need to pay again.");
        return;
      }

      const expectedId = pendingRequests.get(sender);
      const looksRight =
        msg.content.amount === PAYWALL_AMOUNT &&
        msg.content.currency === PAYWALL_CURRENCY &&
        msg.content.currencyId === PAYWALL_CURRENCY_ID &&
        msg.content.fromIdentityKey === sender;

      // Strict requestId match preferred; fall back to a loose match on
      // amount/currency/payer if we have no pending entry — e.g. the bot
      // restarted since sending the payment_request (no persistence here,
      // see top-of-file comment), which would otherwise strand a legitimate
      // payer's receipt against an empty map.
      if (msg.content.requestId !== expectedId && !(!expectedId && looksRight)) {
        await bot.reply(msg, "That payment doesn't match an outstanding request — DM me to get a fresh one.");
        return;
      }

      // Mark verified / clear pending synchronously before the await below,
      // so a near-duplicate receipt sees the post-state instead of racing
      // into a second addParticipant call.
      verified.add(sender);
      pendingRequests.delete(sender);

      try {
        await bot.core.addParticipant(PAYWALL_CHAT_ID!, sender);
        await bot.reply(msg, "Payment received — you're in!");
      } catch (err) {
        if (err instanceof EvergramAccessDeniedError) {
          console.error(
            `[paywall-bot] paid but couldn't add ${sender} — bot lacks admin rights on ${PAYWALL_CHAT_ID}`
          );
          await bot.reply(msg, "Payment received, but I couldn't add you automatically — an admin will follow up.");
          return;
        }
        throw err;
      }
      return;
    }

    // Text/audio/anything else.
    if (verified.has(sender)) {
      await bot.reply(msg, "You're already in the group — nothing more to do.");
      return;
    }

    if (pendingRequests.has(sender)) {
      await bot.reply(msg, `Still waiting on payment of ${PAYWALL_AMOUNT} ${PAYWALL_CURRENCY} — send the receipt when you're done.`);
      return;
    }

    sendPaymentRequest(msg.chatId, sender);
  });

  await bot.start();
  console.log(`[paywall-bot] online as ${wallet.address}, gating chat ${PAYWALL_CHAT_ID}`);
}

main().catch((err) => {
  console.error("[paywall-bot] fatal:", err);
  process.exit(1);
});
