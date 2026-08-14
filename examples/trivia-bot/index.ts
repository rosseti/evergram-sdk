import { join } from "node:path";
import { EvergramBot, typingDelayMs } from "../../src/index.js";
import { loadOrCreateIdentity } from "../_shared/load-identity.js";
import { logBotError } from "../_shared/log-error.js";
import { QUESTIONS } from "./questions.js";

const GATEWAY_URL = process.env.EVERGRAM_GATEWAY_URL || "ws://localhost:9000/api/ws";
const ROUND_TIMEOUT_MS = 30_000;

// Log once at module load so a missing/wrong .env is obvious before connect fails.
console.log(`[trivia-bot] gateway: ${GATEWAY_URL}`);

const HELP_TEXT = [
  "!trivia: ask a new question",
  "!skip: reveal the answer and skip the current question",
  "!score: show this chat's scoreboard",
  "!help: show this message",
].join("\n");

// Old-school IRC trivia bots (like the classic "!gama" games) ran one round
// at a time per channel, took the first correct answer, and kept an
// in-memory scoreboard for the session. This example reproduces that same
// shape on top of Evergram chats; no persistence across restarts, just
// per-chat state held in memory while the process is alive.
interface Round {
  answer: string; // normalized, for matching
  rawAnswer: string; // original casing, for the reveal message
  // Cancels whatever timer(s) are currently pending for this round — the
  // outer ROUND_TIMEOUT_MS wait, or (once it fires) the nested
  // typingDelayMs wait before the reveal actually goes out. A single
  // function instead of a bare timer handle so !skip can't race the
  // reveal: see scheduleReveal below.
  cancel: () => void;
}

const rounds = new Map<string, Round>(); // chatId -> active question
const scores = new Map<string, Map<string, number>>(); // chatId -> (identity -> points)

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics for loose matching
    .replace(/[^a-z0-9]/g, ""); // ignore spacing/punctuation, e.g. "multi-signing" vs "multi signing"
}

// `identity` is already a "<chainFamily>:<address>" identityKey (same shape
// as msg.sender); prefixing it with "@" lets every Evergram client resolve
// it to that person's own cached nickname locally (falling back to a
// shortened address if uncached), the same way a composer-inserted @mention
// renders. No need for this bot to fetch/cache nicknames itself anymore.
function mention(identity: string): string {
  return `@${identity}`;
}

function scoreboard(chatId: string): string {
  const chatScores = scores.get(chatId);
  if (!chatScores || chatScores.size === 0) return "No one has scored yet.";

  return [...chatScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([identity, points], i) => `${i + 1}. ${mention(identity)}: ${points}`)
    .join("\n");
}

function awardPoint(chatId: string, identity: string): number {
  const chatScores = scores.get(chatId) ?? new Map<string, number>();
  const next = (chatScores.get(identity) ?? 0) + 1;
  chatScores.set(identity, next);
  scores.set(chatId, chatScores);
  return next;
}

// Ends the round without awarding a point; used by both the timeout and
// !skip. Always cancels first: !skip firing this manually must not leave
// the reveal (still possibly mid-typing-delay) pending to fire on its own
// afterward — see scheduleReveal.
function endRound(chatId: string): Round | undefined {
  const round = rounds.get(chatId);
  if (!round) return undefined;
  round.cancel();
  rounds.delete(chatId);
  return round;
}

// Schedules the "time's up" reveal ROUND_TIMEOUT_MS from now, and returns a
// cancel() that unwinds whichever stage is currently pending. Deliberately
// does NOT delete `rounds.get(chatId)` until the reveal message has
// actually been sent — replyWithTyping's typing-indicator delay means the
// gap between "timer fires" and "message sent" can be up to ~2s, and this
// round must stay "open" (so !trivia/!skip see it) for that whole window.
// Otherwise a fast !trivia right as the timer fires opens a new round
// before this one's reveal is even on the wire, and the stale reveal for
// the old question lands in the middle of the new one.
function scheduleReveal(
  bot: EvergramBot,
  chatId: string,
  question: { question: string; answer: string },
): () => void {
  // Two separately-cancellable stages, not a single sendTypedMessage() —
  // that call's internal typing-delay wait isn't externally abortable, and
  // a !skip landing mid-wait must be able to stop the reveal from going
  // out at all, not just clean up bookkeeping after the fact.
  let innerTimer: ReturnType<typeof setTimeout> | undefined;

  const outerTimer = setTimeout(() => {
    const reveal = `⏰ Time's up! The answer was: ${question.answer}`;
    bot.trySendTyping(chatId, true);
    innerTimer = setTimeout(() => {
      bot.trySendTyping(chatId, false);
      // setTimeout's callback runs outside bindEvent's wrapper, so a
      // rejected sendMessage here would otherwise become an unhandled
      // rejection; route it through the same "error" event by hand.
      bot.core.sendMessage(chatId, reveal).catch((err) => bot.core.emit("error", err));
      rounds.delete(chatId);
    }, typingDelayMs(reveal));
  }, ROUND_TIMEOUT_MS);

  return () => {
    clearTimeout(outerTimer);
    if (innerTimer) clearTimeout(innerTimer);
  };
}

async function main() {
  const { wallet, device } = loadOrCreateIdentity(join(__dirname, "identity.json"));

  const bot = new EvergramBot({ url: GATEWAY_URL, wallet, device, name: "TriviaBot" });
  bot.core.on("disconnected", () => console.warn("[trivia-bot] disconnected from gateway"));
  bot.core.on("reconnecting", (attempt) =>
    console.warn(`[trivia-bot] reconnecting (attempt ${attempt})`),
  );
  bot.core.on("authenticated", () => console.log("[trivia-bot] (re)authenticated"));

  bot.onMessage(async (msg, chat) => {
    if (!chat) return; // chat metadata not synced yet
    if (msg.content.type !== "text" || !msg.content.text) return;

    const text = msg.content.text.trim();
    const command = text.toLowerCase();

    if (command === "!help") {
      await bot.replyWithTyping(msg, HELP_TEXT);
      return;
    }

    if (command === "!trivia") {
      const existing = rounds.get(msg.chatId);
      if (existing) {
        await bot.replyWithTyping(msg, "There's already a question open! Answer it, or use !skip.");
        return;
      }

      const question = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
      const cancel = scheduleReveal(bot, msg.chatId, question);
      rounds.set(msg.chatId, {
        answer: normalize(question.answer),
        rawAnswer: question.answer,
        cancel,
      });
      await bot.replyWithTyping(
        msg,
        `🎲 ${question.question} (${ROUND_TIMEOUT_MS / 1000}s to answer)`,
      );
      return;
    }

    if (command === "!skip") {
      const round = endRound(msg.chatId);
      if (!round) {
        await bot.replyWithTyping(msg, "No question is open right now. Ask one with !trivia.");
        return;
      }
      await bot.replyWithTyping(msg, `⏭️ Skipped. The answer was: ${round.rawAnswer}`);
      return;
    }

    if (command === "!score") {
      await bot.replyWithTyping(msg, `🏆 Scoreboard:\n${scoreboard(msg.chatId)}`);
      return;
    }

    const round = rounds.get(msg.chatId);
    if (!round) return; // no open question; plain chat, ignore

    if (normalize(text) === round.answer) {
      endRound(msg.chatId);
      const points = awardPoint(msg.chatId, msg.sender);
      await bot.replyWithTyping(
        msg,
        `✅ Correct, ${mention(msg.sender)}! You now have ${points} point(s). Ask for another with !trivia.`,
      );
    }
  });

  await bot.start();
  console.log(`[trivia-bot] online as ${wallet.address}`);
  // Registered only after a successful start: a failure during start()
  // already rejects the promise above (see main().catch below), so an
  // "error" listener attached earlier would log that same failure twice.
  // From here on it only reports background issues (dropped connections,
  // rate limits, etc.) that happen after the bot is already running.
  bot.core.on("error", (err) => logBotError("[trivia-bot] error:", err));
}

main().catch((err) => {
  logBotError("[trivia-bot] fatal:", err);
  process.exit(1);
});
