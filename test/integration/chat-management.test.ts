import { afterEach, describe, expect, it } from "vitest";
import { EvergramCore } from "../../src/core.js";
import { identityKey } from "../../src/identity.js";
import { ChainFamily } from "../../src/proto/evergram.js";
import { adminIdentityOrSkip, freshIdentity, waitUntil, WS_URL } from "./_helpers.js";

// Requires the local stack up — see sdk/README.md's "Testing" section.

const openCores: EvergramCore[] = [];

afterEach(() => {
  while (openCores.length) openCores.pop()!.close();
});

async function connectWithIdentity(identity: ReturnType<typeof freshIdentity>) {
  const core = new EvergramCore({ url: WS_URL, ...identity });
  openCores.push(core);
  await core.connect();
  return { core, address: identity.wallet.address };
}

async function connectFreshBot() {
  return connectWithIdentity(freshIdentity());
}

describe("chat management — no elevated tier needed", () => {
  it("getProfile round-trips the nickname set by setProfile", async () => {
    const botA = await connectFreshBot();
    const botB = await connectFreshBot();
    const identityA = identityKey({ chainFamily: ChainFamily.XRPL, address: botA.address });

    await botA.core.setProfile({ nickname: "Bot A" });
    const profile = await botB.core.getProfile(identityA);

    expect(profile?.nickname).toBe("Bot A");
  });

  it("reportUser is accepted against a known identity", async () => {
    const reporter = await connectFreshBot();
    const target = await connectFreshBot();
    const targetIdentity = identityKey({ chainFamily: ChainFamily.XRPL, address: target.address });

    const resp = await reporter.core.reportUser(targetIdentity, "spam");
    expect(resp.status?.ok).toBe(true);
  });

  it("sendTyping delivers a typing event to the other side of a one-on-one chat", async () => {
    const botA = await connectFreshBot();
    const botB = await connectFreshBot();
    const identityA = identityKey({ chainFamily: ChainFamily.XRPL, address: botA.address });
    const identityB = identityKey({ chainFamily: ChainFamily.XRPL, address: botB.address });

    const created = await botA.core.createChat("one-on-one", [identityA, identityB]);
    const chatId = created.chat!.chatId!;
    await waitUntil(() => !!botB.core.getChat(chatId));

    const typingEvents: any[] = [];
    botB.core.on("typing", (evt) => typingEvents.push(evt));

    botA.core.sendTyping(chatId, true);

    await waitUntil(() => typingEvents.length > 0);
    expect(typingEvents[0]).toMatchObject({ chatId, isTyping: true });
  });

  it("leaveChat rejects a one-on-one chat — group chats only", async () => {
    const botA = await connectFreshBot();
    const botB = await connectFreshBot();
    const identityA = identityKey({ chainFamily: ChainFamily.XRPL, address: botA.address });
    const identityB = identityKey({ chainFamily: ChainFamily.XRPL, address: botB.address });

    const created = await botA.core.createChat("one-on-one", [identityA, identityB]);
    const chatId = created.chat!.chatId!;

    await expect(botA.core.leaveChat(chatId)).rejects.toMatchObject({
      code: "leave_not_allowed",
    });
  });
});

// These need a wallet with the group:create capability (beta/ga/admin tier —
// see contract/contract/access.config.json), which the default local "early"
// tier doesn't have. Set EVERGRAM_TEST_ADMIN_SEED to a seed already granted
// one of those tiers on your local stack to run them; otherwise they're
// skipped rather than failing on a setup most local stacks won't have.
const admin = adminIdentityOrSkip();

describe.skipIf(!admin)("chat management — group-only (needs EVERGRAM_TEST_ADMIN_SEED)", () => {
  it("updateChatRoles promotes a participant to moderator, visible on both sides", async () => {
    const founder = await connectWithIdentity(admin!);
    const member = await connectFreshBot();
    const founderIdentity = identityKey({ chainFamily: ChainFamily.XRPL, address: founder.address });
    const memberIdentity = identityKey({ chainFamily: ChainFamily.XRPL, address: member.address });

    const created = await founder.core.createChat("group", [founderIdentity, memberIdentity]);
    const chatId = created.chat!.chatId!;
    await waitUntil(() => !!member.core.getChat(chatId));

    await founder.core.updateChatRoles(chatId, {
      admins: [founderIdentity],
      moderators: [memberIdentity],
    });

    await waitUntil(() => !!founder.core.getChat(chatId)?.meta?.roles?.moderators?.includes(memberIdentity));
    await waitUntil(() => !!member.core.getChat(chatId)?.meta?.roles?.moderators?.includes(memberIdentity));
  });

  it("setChatMode toggles moderated and bumps chatVersion", async () => {
    const founder = await connectWithIdentity(admin!);
    const member = await connectFreshBot();
    const founderIdentity = identityKey({ chainFamily: ChainFamily.XRPL, address: founder.address });
    const memberIdentity = identityKey({ chainFamily: ChainFamily.XRPL, address: member.address });

    // The contract requires at least 2 distinct participants total (chat
    // makes no sense with just the creator) — see evergram-contract.js's
    // `participantList.length < 2` check ("no_participants").
    const created = await founder.core.createChat("group", [founderIdentity, memberIdentity]);
    const chatId = created.chat!.chatId!;
    const versionBefore = founder.core.getChat(chatId)!.chatVersion;

    await founder.core.setChatMode(chatId, { moderated: true });

    await waitUntil(() => (founder.core.getChat(chatId)?.chatVersion ?? 0) > (versionBefore ?? 0));
    expect(founder.core.getChat(chatId)?.meta?.modes?.moderated).toBe(true);
  });

  it("leaveChat removes a non-founder participant from the group on both sides", async () => {
    const founder = await connectWithIdentity(admin!);
    const member = await connectFreshBot();
    const founderIdentity = identityKey({ chainFamily: ChainFamily.XRPL, address: founder.address });
    const memberIdentity = identityKey({ chainFamily: ChainFamily.XRPL, address: member.address });

    const created = await founder.core.createChat("group", [founderIdentity, memberIdentity]);
    const chatId = created.chat!.chatId!;
    await waitUntil(() => !!member.core.getChat(chatId));

    await member.core.leaveChat(chatId);

    await waitUntil(() => !founder.core.getChat(chatId)?.participants?.includes(memberIdentity));
  });
});
