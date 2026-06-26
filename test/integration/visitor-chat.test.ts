import { afterEach, describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { EvergramBot, VisitorSessionHandle } from "../../src/bot";
import { EvergramCore } from "../../src/core";
import { buildTextFramePayload, decryptTextFramePayload } from "../../src/ephemeral-relay-session";
import { decodeRelayPayload, encodeRelayPayload } from "../../src/relay-message-codec";
import { ClientMessage, RelayMessageKind } from "../../src/proto/evergram";
import { freshIdentity, waitUntil, WS_URL } from "./_helpers";
import { openRawConnection, RawClient } from "./_raw-client";

// Requires the local stack up — see sdk/README.md's "Testing" section. The
// "visitor" side is deliberately the same low-level _raw-client.ts helper
// the auth tests use, not EvergramCore/EvergramBot — an anonymous widget
// visitor is, by protocol design, never authenticated at all (see
// createVisitorRoom.ts on the gateway), so there's no SDK-level client for
// that role to exercise here.

const openCores: EvergramCore[] = [];
const openRawClients: RawClient[] = [];

afterEach(() => {
  while (openCores.length) openCores.pop()!.close();
  while (openRawClients.length) openRawClients.pop()!.close();
});

async function connectFreshBot(): Promise<EvergramBot> {
  const bot = new EvergramBot({ url: WS_URL, ...freshIdentity() });
  openCores.push(bot.core);
  await bot.start();
  return bot;
}

async function connectRawVisitor(): Promise<RawClient> {
  const client = await openRawConnection(WS_URL);
  openRawClients.push(client);
  return client;
}

async function openVisitorRoom(visitor: RawClient, widgetId: string, visitorLabel: string, text: string) {
  const symKey = nacl.randomBytes(32);
  const { payloadText } = buildTextFramePayload(symKey, visitorLabel, text);

  visitor.send(
    ClientMessage.create({
      createVisitorRoom: { widgetId, symKey, visitorLabel, firstMessagePayload: encodeRelayPayload(payloadText) },
    })
  );

  const response = await visitor.waitFor("createVisitorRoomResponse");
  return { roomToken: response.roomToken!, symKey };
}

describe("widget-visitor chat", () => {
  it("delivers a visitor's opening message to the bot and the bot's reply back to the visitor", async () => {
    const bot = await connectFreshBot();
    const widgetResponse = await bot.core.createWidget("Test Widget");
    const widgetId = widgetResponse.widget!.widgetId!;

    const firstMessages: (string | null)[] = [];
    let handle: VisitorSessionHandle | undefined;
    bot.onVisitorRoomRequested((h, firstMessage) => {
      handle = h;
      firstMessages.push(firstMessage?.text ?? null);
      h.reply("hello from bot");
    });

    const visitor = await connectRawVisitor();
    const { roomToken, symKey } = await openVisitorRoom(visitor, widgetId, "Curious Visitor", "hello from visitor");

    await waitUntil(() => firstMessages.length > 0);
    expect(firstMessages[0]).toBe("hello from visitor");
    expect(handle?.roomToken).toBe(roomToken);
    expect(handle?.visitorLabel).toBe("Curious Visitor");

    // The first relayMessage the visitor sees is the bot's eager "joined"
    // echo (see EvergramCore.handleVisitorRoomRequestedEvent) — the text
    // reply follows right after, on the same connection.
    const joinedFrame = await visitor.waitFor("relayMessage");
    expect(joinedFrame.kind).toBe(RelayMessageKind.RELAY_JOINED);

    const replyFrame = await visitor.waitFor("relayMessage");
    expect(replyFrame.kind).toBe(RelayMessageKind.RELAY_TEXT);

    const decoded = decryptTextFramePayload(symKey, decodeRelayPayload(replyFrame.payload));
    expect(decoded?.text).toBe("hello from bot");
  });

  it("lets the bot end the conversation, and the visitor sees the room close", async () => {
    const bot = await connectFreshBot();
    const widgetResponse = await bot.core.createWidget("Test Widget 2");
    const widgetId = widgetResponse.widget!.widgetId!;

    let handle: VisitorSessionHandle | undefined;
    bot.onVisitorRoomRequested((h) => {
      handle = h;
    });

    const visitor = await connectRawVisitor();
    await openVisitorRoom(visitor, widgetId, "Another Visitor", "hi");

    await waitUntil(() => !!handle);
    await visitor.waitFor("relayMessage"); // consume the eager "joined" echo

    handle!.end();

    const endFrame = await visitor.waitFor("relayMessage");
    expect(endFrame.kind).toBe(RelayMessageKind.RELAY_END);
  });
});
