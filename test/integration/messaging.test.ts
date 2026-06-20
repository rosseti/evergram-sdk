import { afterEach, describe, expect, it } from "vitest";
import { EvergramChatMessage, EvergramCore } from "../../src/core";
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
