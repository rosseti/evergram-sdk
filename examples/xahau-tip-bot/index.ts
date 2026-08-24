import { join } from "node:path";
import { Client } from "xrpl";
import {
  EvergramBot,
  parseIdentityKey,
  type ChatInfo,
  type EvergramChatMessage,
} from "../../src/index.js";
import { loadOrCreateIdentity } from "../_shared/load-identity.js";
import { logBotError } from "../_shared/log-error.js";
import { parseTipCommand, type TipTarget } from "./commands.js";
import { createSerialQueue } from "./serial-queue.js";
import { loadProcessedTips, recordProcessedTip, type ProcessedTip } from "./tip-ledger.js";
import { fundingWalletFrom, getAvailableBalanceXah, sendXahPayment } from "./xahau-client.js";

const GATEWAY_URL = process.env.EVERGRAM_GATEWAY_URL || "ws://localhost:9000/api/ws";
const XAHAU_WS_URL = process.env.XAHAU_WS_URL || "wss://xahau-test.net";
const TIPBOT_OWNER = process.env.TIPBOT_OWNER;
// Set to see every step of !tip resolution and payment submission. Useful
// while diagnosing a wrong-target or fee report, noisy for normal running.
// xahau-client.ts reads this same env var independently for its own debug
// logging, rather than importing this constant, so each module stays
// self-contained about its own config the way every other example here does.
const DEBUG = process.env.TIPBOT_DEBUG === "true";
// Absolute ceiling on what a single payment's Fee may reach, including all
// of sendXahPayment's fee-escalation retries (see xahau-client.ts): well
// above ordinary network fees but nowhere near xrpl.js's own 2 XAH default,
// which would let a misbehaving retry loop burn real money on fees alone.
const TIPBOT_MAX_FEE_XAH = process.env.TIPBOT_MAX_FEE_XAH || "0.05";
// Optional hard cap on a single !tip's amount. Unset means no cap, same as
// the original XRPTipBot's model (whatever you've deposited, you can send).
// Recommended once this bot is pointed at mainnet with real value in it.
const TIPBOT_MAX_TIP_XAH = process.env.TIPBOT_MAX_TIP_XAH
  ? Number(process.env.TIPBOT_MAX_TIP_XAH)
  : null;

if (!TIPBOT_OWNER) {
  console.error("[xahau-tip-bot] TIPBOT_OWNER env var is required (identityKey of the only");
  console.error("[xahau-tip-bot] identity this bot takes commands from, e.g. '1:rYourAddress...')");
  process.exit(1);
}

if (
  TIPBOT_MAX_TIP_XAH !== null &&
  (!Number.isFinite(TIPBOT_MAX_TIP_XAH) || TIPBOT_MAX_TIP_XAH <= 0)
) {
  console.error(
    `[xahau-tip-bot] TIPBOT_MAX_TIP_XAH must be a positive number, got ${process.env.TIPBOT_MAX_TIP_XAH}`,
  );
  process.exit(1);
}

function resolveTargetAddress(target: TipTarget): string {
  if (target.kind === "address") return target.address;
  // reply/mention targets carry an Evergram identityKey, which for
  // ChainFamily.XRPL already embeds the ledger address (see
  // src/identity.ts). No lookup needed.
  return parseIdentityKey(target.identityKey).address;
}

// This is a *personal* bot, not a custodial service: unlike the original
// XRPTipBot (per-user deposit addresses + an off-chain balance ledger + a
// withdraw step), there is exactly one wallet here (the bot's own), and
// every !tip is a real, immediate Xahau Payment straight out of it. That
// wallet is the *same* seed that authenticates this bot's Evergram chat
// identity (see xahau-client.ts's fundingWalletFrom): losing identity.json
// here doesn't just orphan chat history like the other examples, it loses
// custody of whatever XAH this bot's address holds. There is deliberately
// no confirmation step before a !tip goes out: a typo'd amount or address
// sends real funds immediately. Defaults to Xahau **testnet**; only point
// XAHAU_WS_URL at mainnet once you're sure you want that.
//
// NOT PRODUCTION-HARDENED. This demonstrates the SDK plumbing for a
// real-payment bot, not a finished production service. A pass of manual
// testnet testing plus an automated code-level security review (no
// high-confidence findings) found and fixed real bugs, but neither
// substitutes for the items below before this should hold value anyone
// other than you would miss:
//   - identity.json is a plaintext seed file, same as every other example
//     here. For real value, put it behind a proper secret store (KMS,
//     Vault, an encrypted volume), not a JSON file on disk.
//   - sendXahPayment()/getAvailableBalanceXah() (xahau-client.ts) have zero
//     automated test coverage. Only the pure-logic pieces (commands.ts,
//     serial-queue.ts, tip-ledger.ts, the retry helpers) are unit tested.
//     Add integration tests against a real or mocked Client before trusting
//     changes here not to regress silently.
//   - tip-ledger.ts closes the common double-pay case (a redelivered
//     message reprocessing an already-successful tip) but not the narrow
//     window between sendXahPayment() succeeding and the record actually
//     being written. Closing that needs reconciling recorded tips against
//     the account's own tx history on the ledger, not just this local file.
//   - No monitoring/alerting (low balance, rising payment-failure rate,
//     process death) and no structured logging: console.log/warn/debug
//     only. Fine for a bot you watch yourself; not for one you'd trust to
//     run unattended.
//   - Never had a human security audit, just this session's automated
//     review. Get one before this handles value that matters to anyone
//     but you.
async function main() {
  const { wallet, device } = loadOrCreateIdentity(join(__dirname, "identity.json"));
  const fundingWallet = fundingWalletFrom(wallet);

  // feeCushion above xrpl.js's own default (1.2x): a public testnet's
  // open-ledger fee can escalate past that default cushion under load from
  // other test traffic, which is exactly what produced the
  // telINSUF_FEE_P/LastLedgerSequence failures seen in testing. See
  // xahau-client.ts's sendXahPayment retry for the other half of this fix.
  // maxFeeXRP replaces xrpl.js's own 2 XAH default with TIPBOT_MAX_FEE_XAH:
  // that default is a reasonable ceiling for XRPL's fee escalation, but
  // Xahau's Hooks-driven fees (see sendXahPayment's escalation) are a
  // different failure mode entirely, and 2 XAH in fees alone would dwarf
  // any sane tip amount.
  const xahau = new Client(XAHAU_WS_URL, { feeCushion: 2, maxFeeXRP: TIPBOT_MAX_FEE_XAH });
  // xrpl.js's Connection already retries an unexpected drop on its own
  // (exponential backoff, internal to the `xrpl` package). These are just
  // visibility into that, same spirit as the bot.core listeners below. A
  // !tip issued while disconnected still fails cleanly: submitTip's catch
  // reports it to the owner rather than silently queuing it.
  xahau.on("connected", () => console.log("[xahau-tip-bot] Xahau: connected"));
  xahau.on("disconnected", (code) => console.warn(`[xahau-tip-bot] Xahau: disconnected (${code})`));
  xahau.on("error", (type, info) => console.warn(`[xahau-tip-bot] Xahau: error (${type})`, info));
  await xahau.connect();

  const tipLedgerPath = join(__dirname, "tip-ledger.json");
  const processedTips = loadProcessedTips(tipLedgerPath);
  const enqueueTip = createSerialQueue();

  const bot = new EvergramBot({ url: GATEWAY_URL, wallet, device, name: "Xahau Tip Bot" });

  bot.core.on("disconnected", () => console.warn("[xahau-tip-bot] disconnected from gateway"));
  bot.core.on("reconnecting", (attempt) =>
    console.warn(`[xahau-tip-bot] reconnecting (attempt ${attempt})`),
  );
  bot.core.on("authenticated", () => console.log("[xahau-tip-bot] (re)authenticated"));

  // msgId -> sender, capped per chat, so "!tip 5" replying to someone's
  // message can resolve a target without needing persisted chat history.
  // Same bounded-cache shape as EvergramCore's own seenEnvelopeKeys.
  const MAX_TRACKED_PER_CHAT = 200;
  const recentMessages = new Map<string, Map<string, string>>();

  function trackMessage(chatId: string, msgId: string, sender: string) {
    const chatMessages = recentMessages.get(chatId) ?? new Map<string, string>();
    chatMessages.set(msgId, sender);
    if (chatMessages.size > MAX_TRACKED_PER_CHAT) {
      const oldest = chatMessages.keys().next().value;
      if (oldest !== undefined) chatMessages.delete(oldest);
    }
    recentMessages.set(chatId, chatMessages);
  }

  const HELP_TEXT = [
    "!tip <amount> [XAH]: reply to someone's message to tip its author",
    "!tip @<identityKey> <amount> [XAH]",
    "!tip <address> <amount> [XAH]",
    "!balance: this bot's available XAH balance",
    "!address: this bot's funding address",
    "!help: this message",
    ...(TIPBOT_MAX_TIP_XAH !== null ? [`(limit: ${TIPBOT_MAX_TIP_XAH} XAH per tip)`] : []),
  ].join("\n");

  bot.onMessage(async (msg, chat) => {
    if (!chat) return;
    if (msg.content.type === "text" && msg.content.text) {
      trackMessage(msg.chatId, msg.msgId, msg.sender);
    }

    if (msg.sender !== TIPBOT_OWNER) return; // personal bot: owner-only commands
    if (msg.content.type !== "text" || !msg.content.text) return;

    const text = msg.content.text.trim();

    if (text === "!help") {
      await bot.replyWithTyping(msg, HELP_TEXT);
      return;
    }

    if (text === "!address") {
      await bot.replyWithTyping(
        msg,
        `Funding address: ${wallet.address}\nFund it via the Xahau testnet faucet before tipping.`,
      );
      return;
    }

    if (text === "!balance") {
      const available = await getAvailableBalanceXah(xahau, wallet.address);
      await bot.replyWithTyping(msg, `Available balance: ${available} XAH`);
      return;
    }

    if (text.startsWith("!tip")) {
      const replySender = msg.replyToMsgId
        ? (recentMessages.get(msg.chatId)?.get(msg.replyToMsgId) ?? null)
        : null;

      if (DEBUG) {
        const tracked = [...(recentMessages.get(msg.chatId)?.entries() ?? [])];
        const trackedSummary =
          tracked.map(([id, sender]) => `${id}->${sender}`).join(", ") || "none";
        console.debug(
          `[xahau-tip-bot] DEBUG !tip: text=${JSON.stringify(text)}` +
            ` msgId=${msg.msgId} replyToMsgId=${msg.replyToMsgId ?? "(none)"}` +
            ` resolvedReplySender=${replySender ?? "(none)"}`,
        );
        console.debug(
          `[xahau-tip-bot] DEBUG !tip: chat ${msg.chatId} tracking ${tracked.length} msgIds: ${trackedSummary}`,
        );
      }

      await handleTip(msg, chat, text, replySender);
    }
  });

  async function handleTip(
    msg: EvergramChatMessage,
    chat: ChatInfo,
    text: string,
    replySender: string | null,
  ) {
    // Idempotency guard: msg.msgId is stable for a given message, including
    // on redelivery (a gateway restart replaying the mailbox, or this bot
    // itself restarting mid-processing). Without this, replaying a !tip
    // whose payment already went through would send it again.
    const already = processedTips.get(msg.msgId);
    if (already) {
      await bot.replyWithTyping(
        msg,
        `Already processed this one: sent ${already.amount} ${already.currency} to ${already.toAddress}, tx ${already.txHash}.`,
      );
      return;
    }

    const parsed = parseTipCommand(text, replySender);
    if (DEBUG)
      console.debug(`[xahau-tip-bot] DEBUG !tip: parseTipCommand -> ${JSON.stringify(parsed)}`);
    if (!parsed.ok) {
      await bot.replyWithTyping(msg, parsed.error);
      return;
    }

    const { amount, currency, target } = parsed.tip;

    if (TIPBOT_MAX_TIP_XAH !== null && Number(amount) > TIPBOT_MAX_TIP_XAH) {
      await bot.replyWithTyping(
        msg,
        `That's above the configured limit of ${TIPBOT_MAX_TIP_XAH} XAH per tip.`,
      );
      return;
    }

    const address = resolveTargetAddress(target);
    if (DEBUG) {
      console.debug(
        `[xahau-tip-bot] DEBUG !tip: resolved target ${JSON.stringify(target)} -> address ${address}`,
      );
    }

    const txHash = await submitTip(msg, address, amount);
    if (!txHash) return; // failure already reported to the owner inside submitTip

    const record: ProcessedTip = {
      msgId: msg.msgId,
      txHash,
      amount,
      currency,
      toAddress: address,
      ts: Date.now(),
    };
    recordProcessedTip(tipLedgerPath, processedTips, record);

    await bot.replyWithTyping(msg, `Sent ${amount} ${currency} to ${address}. tx ${txHash}`);

    // Announce it in-chat, but only when we can be sure the recipient is
    // actually there to see it: a "reply" target's identityKey came from a
    // message tracked in this exact chatId, so it's a real participant. A
    // "mention"/"address" target could be anyone, possibly not even an
    // Evergram user, so there's no chat to announce into. Skipped in 1:1s
    // too: that's just the owner and the bot, no one else to tell. Opening
    // a fresh DM to notify a stranger was considered and dropped: it's an
    // unsolicited chat request, and silently no-ops for anyone with
    // requireChatApproval on (see README "Access tiers").
    if (target.kind === "reply" && chat.type === "group") {
      await bot.core.sendMessage(
        msg.chatId,
        `@${target.identityKey} got tipped ${amount} ${currency}! tx ${txHash}`,
      );
    }
  }

  // Returns the tx hash on success, or null after reporting the failure to
  // the owner (kept separate from handleTip so its early-return-on-failure
  // shape doesn't add another branch to that function's complexity).
  async function submitTip(
    msg: EvergramChatMessage,
    toAddress: string,
    amount: string,
  ): Promise<string | null> {
    try {
      // Queued rather than called directly: sendXahPayment's autofill()
      // reads the account's current Sequence, and two submissions in flight
      // at once would race for it. enqueueTip guarantees this one doesn't
      // start until every earlier tip has fully settled.
      const result = await enqueueTip(() =>
        sendXahPayment(xahau, fundingWallet, toAddress, amount),
      );
      const meta = result.result.meta;
      const engineResult = typeof meta === "object" && meta ? meta.TransactionResult : undefined;
      if (engineResult && engineResult !== "tesSUCCESS") {
        await bot.replyWithTyping(msg, `Payment failed: ${engineResult}`);
        return null;
      }
      return result.result.hash ?? "(unknown)";
    } catch (err) {
      await bot.replyWithTyping(
        msg,
        `Payment failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  await bot.start();
  bot.core.on("error", (err) => logBotError("[xahau-tip-bot] error:", err));
  console.log(`[xahau-tip-bot] online as ${wallet.address} (Xahau: ${XAHAU_WS_URL})`);
  console.log(`[xahau-tip-bot] taking commands only from ${TIPBOT_OWNER}`);
}

main().catch((err) => {
  logBotError("[xahau-tip-bot] fatal:", err);
  process.exit(1);
});
