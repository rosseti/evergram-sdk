import { join } from "node:path";
import { EvergramBot } from "../../src";
import { loadOrCreateIdentity } from "../_shared/load-identity";

const GATEWAY_URL = process.env.EVERGRAM_GATEWAY_URL || "ws://localhost:9000/api/ws";

// Identity keys ("1:rAddress...") allowed to auto-join managed chats.
// Replace with your own rule — an account-age check via a profile lookup,
// a database of vetted addresses, etc. This example keeps the rule itself
// trivial so the join-request *plumbing* is what stands out.
const ALLOWLIST = new Set(
  (process.env.MODERATION_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean)
);

// Identity keys to auto-promote to moderator once they join via the
// allowlist above — demonstrates updateChatRoles(). Optional: leave unset
// and approval still works, just without the promotion step.
const PROMOTE = new Set(
  (process.env.MODERATION_PROMOTE || "").split(",").map((s) => s.trim()).filter(Boolean)
);

// Note: this bot needs `group:create`/admin rights on the chats it manages.
// A freshly generated wallet starts in the contract's default "early" tier,
// which does not have that capability — see README "Access tiers" section.
// Either grant beta access to this bot's address first, or run it against a
// group an already-privileged account created and added this bot to.
async function main() {
  const { wallet, device } = loadOrCreateIdentity(join(__dirname, "identity.json"));

  const bot = new EvergramBot({ url: GATEWAY_URL, wallet, device });
  bot.core.on("error", (err) => console.error("[moderation-bot] error:", err));
  bot.core.on("disconnected", () => console.warn("[moderation-bot] disconnected from gateway"));
  bot.core.on("reconnecting", (attempt) => console.warn(`[moderation-bot] reconnecting (attempt ${attempt})`));
  bot.core.on("authenticated", () => console.log("[moderation-bot] (re)authenticated"));

  bot.onJoinRequest(async (req) => {
    if (ALLOWLIST.has(req.identity)) {
      console.log(`[moderation-bot] approving ${req.identity} for chat ${req.chatId}`);
      await req.approve();
      await bot.core.sendMessage(req.chatId, `Welcome, ${req.identity}!`);

      if (PROMOTE.has(req.identity)) {
        // updateChatRoles() replaces the full admins/moderators lists, not a
        // delta — read the current ones first and append to them.
        const roles = bot.core.getChat(req.chatId)?.meta?.roles;
        const admins = roles?.admins ?? [];
        const moderators = roles?.moderators ?? [];
        await bot.core.updateChatRoles(req.chatId, {
          admins,
          moderators: [...moderators, req.identity],
        });
        console.log(`[moderation-bot] promoted ${req.identity} to moderator in chat ${req.chatId}`);
      }
      return;
    }

    // req.deny() always throws — the protocol has no reject RPC today (see
    // JoinRequestHandle's doc comment in src/bot.ts). Leaving the request
    // alone keeps it pending until a human admin decides, or it's cleared
    // some other way. reportUser() here is a one-off demo of the RPC, not a
    // recommended policy — flagging every non-allowlisted request would spam
    // reports for an ordinary public chat; a real bot would gate this behind
    // a repeat-offender count instead.
    console.log(`[moderation-bot] ${req.identity} is not on the allowlist, leaving request pending`);
    await bot.core.reportUser(req.identity, "join request denied: not on allowlist");
  });

  await bot.start();
  console.log(`[moderation-bot] online as ${wallet.address}`);
}

main().catch((err) => {
  console.error("[moderation-bot] fatal:", err);
  process.exit(1);
});
