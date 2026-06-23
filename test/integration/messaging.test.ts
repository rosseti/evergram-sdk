import { afterEach, describe, expect, it } from "vitest";
import {
  EvergramChatMessage,
  EvergramCore,
  EvergramMessageDeleted,
  EvergramMessageEdited,
  EvergramReaction,
} from "../../src/core";
import { identityKey } from "../../src/identity";
import { ChainFamily } from "../../src/proto/evergram";
import { freshIdentity, waitUntil, WS_URL } from "./_helpers";

// Requires the local stack up — see sdk/README.md's "Testing" section.
// Default tier ("early") can create one-on-one chats (chat:create) without
// needing group:create, so two fresh wallets are enough here.

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

describe("end-to-end encrypted messaging", () => {
  it("delivers a one-on-one message and decrypts it on the recipient's side", async () => {
    const botA = await connectFreshBot();
    const botB = await connectFreshBot();

    const identityA = identityKey({ chainFamily: ChainFamily.XRPL, address: botA.address });
    const identityB = identityKey({ chainFamily: ChainFamily.XRPL, address: botB.address });

    const created = await botA.core.createChat("one-on-one", [identityA, identityB]);
    const chatId = created.chat!.chatId!;

    // createChatResponse is broadcast to every participant's open
    // connections (see gateway/handlers/outbound/createChatResponse.ts), so
    // botB derives its own copy of the chat key without any extra round trip
    // — just needs a moment to arrive and be processed.
    await waitUntil(() => !!botB.core.getChat(chatId));

    const received: EvergramChatMessage[] = [];
    botB.core.on("message", (msg: EvergramChatMessage) => received.push(msg));

    await botA.core.sendMessage(chatId, "ola evergram");

    await waitUntil(() => received.length > 0);
    expect(received[0].text).toBe("ola evergram");
    expect(received[0].chatId).toBe(chatId);
  });

  it("rediscovers a pre-existing chat and its key after a fresh process restart, with no manual syncChats() call", async () => {
    const botA = await connectFreshBot();
    const identityBWallet = freshIdentity();
    const botB = await connectWithIdentity(identityBWallet);

    const identityA = identityKey({ chainFamily: ChainFamily.XRPL, address: botA.address });
    const identityB = identityKey({ chainFamily: ChainFamily.XRPL, address: botB.address });

    const created = await botA.core.createChat("one-on-one", [identityA, identityB]);
    const chatId = created.chat!.chatId!;
    await waitUntil(() => !!botB.core.getChat(chatId));

    // Simulates botB's process being killed and restarted: a brand new
    // EvergramCore (empty chats/symKeys maps) reusing the exact same
    // wallet+device, with no syncChats() call from test code — this is
    // exactly what EvergramBot.start()/the echo-bot example do, nothing more.
    botB.core.close();
    const botBRestarted = await connectWithIdentity(identityBWallet);

    await waitUntil(() => !!botBRestarted.core.getChat(chatId));

    const received: EvergramChatMessage[] = [];
    botBRestarted.core.on("message", (msg: EvergramChatMessage) => received.push(msg));

    await botA.core.sendMessage(chatId, "ainda funciona depois do restart?");

    await waitUntil(() => received.length > 0);
    expect(received[0].text).toBe("ainda funciona depois do restart?");
  });
});

describe("reactions", () => {
  it("delivers a reaction and its removal to the other participant", async () => {
    const botA = await connectFreshBot();
    const botB = await connectFreshBot();

    const identityA = identityKey({ chainFamily: ChainFamily.XRPL, address: botA.address });
    const identityB = identityKey({ chainFamily: ChainFamily.XRPL, address: botB.address });

    const created = await botA.core.createChat("one-on-one", [identityA, identityB]);
    const chatId = created.chat!.chatId!;
    await waitUntil(() => !!botB.core.getChat(chatId));

    const { msgId } = await botA.core.sendMessage(chatId, "react to this");

    // Listening on botA, not botB: the gateway never echoes a REACT back to
    // the connection that sent it (see reactToMessage.ts's self-device
    // fan-out, which always excludes the originating deviceId) — botB
    // reacting to its own action would never see its own "reaction" event.
    const reactions: EvergramReaction[] = [];
    botA.core.on("reaction", (r: EvergramReaction) => reactions.push(r));

    await botB.core.reactToMessage(chatId, msgId, "❤️");
    await waitUntil(() => reactions.length > 0);
    expect(reactions[0].msgId).toBe(msgId);
    expect(reactions[0].emoji).toBe("❤️");
    expect(reactions[0].removed).toBe(false);

    await botB.core.removeReaction(chatId, msgId);
    await waitUntil(() => reactions.length > 1);
    expect(reactions[1].removed).toBe(true);
    expect(reactions[1].emoji).toBeNull();
  });
});

describe("editing and deleting messages", () => {
  it("delivers an edit within the window and the recipient sees the updated text", async () => {
    const botA = await connectFreshBot();
    const botB = await connectFreshBot();

    const identityA = identityKey({ chainFamily: ChainFamily.XRPL, address: botA.address });
    const identityB = identityKey({ chainFamily: ChainFamily.XRPL, address: botB.address });

    const created = await botA.core.createChat("one-on-one", [identityA, identityB]);
    const chatId = created.chat!.chatId!;
    await waitUntil(() => !!botB.core.getChat(chatId));

    const { msgId } = await botA.core.sendMessage(chatId, "original text");

    const edits: EvergramMessageEdited[] = [];
    botB.core.on("messageEdited", (e: EvergramMessageEdited) => edits.push(e));

    await botA.core.editMessage(chatId, msgId, "edited text");

    await waitUntil(() => edits.length > 0);
    expect(edits[0].msgId).toBe(msgId);
    expect(edits[0].text).toBe("edited text");
  });

  it("delivers a delete-for-everyone and the recipient gets a tombstone event", async () => {
    const botA = await connectFreshBot();
    const botB = await connectFreshBot();

    const identityA = identityKey({ chainFamily: ChainFamily.XRPL, address: botA.address });
    const identityB = identityKey({ chainFamily: ChainFamily.XRPL, address: botB.address });

    const created = await botA.core.createChat("one-on-one", [identityA, identityB]);
    const chatId = created.chat!.chatId!;
    await waitUntil(() => !!botB.core.getChat(chatId));

    const { msgId } = await botA.core.sendMessage(chatId, "delete me");

    const deletions: EvergramMessageDeleted[] = [];
    botB.core.on("messageDeleted", (d: EvergramMessageDeleted) => deletions.push(d));

    await botA.core.deleteMessage(chatId, msgId);

    await waitUntil(() => deletions.length > 0);
    expect(deletions[0].msgId).toBe(msgId);
  });

  it("rejects editing someone else's message", async () => {
    const botA = await connectFreshBot();
    const botB = await connectFreshBot();

    const identityA = identityKey({ chainFamily: ChainFamily.XRPL, address: botA.address });
    const identityB = identityKey({ chainFamily: ChainFamily.XRPL, address: botB.address });

    // A plain 1:1 chat is enough — a fresh ("early"-tier) wallet can't
    // create groups (group:create is gated), and isn't needed here anyway:
    // botB is a genuine participant (passes the participants check) but
    // never sent msg_id, so the gateway's recentSends sender-match check
    // (not the participants check) is what must reject this.
    const created = await botA.core.createChat("one-on-one", [identityA, identityB]);
    const chatId = created.chat!.chatId!;
    await waitUntil(() => !!botB.core.getChat(chatId));

    const { msgId } = await botA.core.sendMessage(chatId, "only A can edit this");

    // editMessage() is fire-and-forget like sendMessage() — it never throws
    // on a server-side rejection. The only observable outcome is the
    // "delivery" event, discriminated by eventType (see core.ts).
    const deliveries: any[] = [];
    botB.core.on("delivery", (d: any) => deliveries.push(d));

    await botB.core.editMessage(chatId, msgId, "hijacked");

    await waitUntil(() => deliveries.length > 0);
    expect(deliveries[0].eventType).toBe("EDIT");
    expect(deliveries[0].status?.ok).toBe(false);
  });
});
