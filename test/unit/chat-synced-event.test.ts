import { describe, expect, it, vi } from "vitest";
import { EvergramCore, EvergramDevice } from "../../src/core.js";
import { deriveDeviceId, generateDeviceKeypair } from "../../src/crypto.js";
import { generateWallet } from "../../src/wallet.js";
import { identityKey } from "../../src/identity.js";
import { ChainFamily, ChatInfo, ChatSyncResult_Status } from "../../src/proto/evergram.js";
import { bytesToBase64, hexToBytes } from "../../src/crypto.js";
import nacl from "tweetnacl";

// A boot syncChats() silently merged every chat it found into the private
// `chats` map with no way for a consumer to learn what showed up — only
// chatKeyRotated fired, and only on an actual rotation of an already-known
// chat, never on first sight. A UI that wants to populate a chat list right
// after connect() (instead of waiting for a message in each chat) had no
// event to listen for and no way to enumerate what syncChats() found.

vi.mock("../../src/transport", () => {
  class FakeTransport {
    onMessage() {
      return () => {};
    }
    onOpen() {
      return () => {};
    }
    onClose() {
      return () => {};
    }
    onReconnecting() {
      return () => {};
    }
    isOpen() {
      return false;
    }
    connect() {
      return Promise.resolve();
    }
    close() {}
    send() {}
  }
  return { Transport: FakeTransport };
});

function makeCore() {
  const wallet = generateWallet();
  const { pubHex, privHex } = generateDeviceKeypair();
  const device: EvergramDevice = {
    deviceId: deriveDeviceId(pubHex),
    devicePubHex: pubHex,
    devicePrivHex: privHex,
  };
  const core = new EvergramCore({ url: "ws://localhost:9000/api/ws", wallet, device });
  const self = identityKey({ chainFamily: ChainFamily.XRPL, address: wallet.address } as any);
  return { core, device, self };
}

function sealForDevice(symKeyHex: string, devicePubHex: string) {
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const ciphertext = nacl.box(
    hexToBytes(symKeyHex),
    nonce,
    hexToBytes(devicePubHex),
    ephemeral.secretKey,
  );

  return {
    ciphertext: bytesToBase64(ciphertext),
    nonce: bytesToBase64(nonce),
    ephemeralPubkey: bytesToBase64(ephemeral.publicKey),
  };
}

function chatWithoutKey(chatId: string): ChatInfo {
  return { chatId, chatVersion: 1, participants: [], symKeyEncrypted: {} } as unknown as ChatInfo;
}

describe("chatSynced", () => {
  it("emits the first time a chat is seen, even without a sealed key yet", () => {
    const { core } = makeCore();
    const handler = vi.fn();
    core.on("chatSynced", handler);

    const chat = chatWithoutKey("new-chat");
    (core as any).processChatInfo(chat);

    expect(handler).toHaveBeenCalledWith(chat);
  });

  it("emits once per chat, not once per sync", () => {
    const { core } = makeCore();
    const handler = vi.fn();
    core.on("chatSynced", handler);

    // A reconnecting bot re-runs syncChats, and processChatInfo runs again
    // for every chat each time.
    for (let i = 0; i < 5; i++) (core as any).processChatInfo(chatWithoutKey("same-chat"));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not re-emit on an actual key rotation of an already-known chat", () => {
    const { core, device, self } = makeCore();
    const handler = vi.fn();
    core.on("chatSynced", handler);

    const chatId = "rotates";
    (core as any).processChatInfo(chatWithoutKey(chatId));
    expect(handler).toHaveBeenCalledTimes(1);

    const sealed = sealForDevice("aa".repeat(32), device.devicePubHex);
    (core as any).processChatInfo({
      chatId,
      chatVersion: 2,
      participants: [],
      symKeyEncrypted: { [self]: { devices: { [device.deviceId]: sealed } } },
    } as unknown as ChatInfo);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("getChats", () => {
  it("returns every chat processChatInfo has seen so far", () => {
    const { core } = makeCore();

    (core as any).processChatInfo(chatWithoutKey("a"));
    (core as any).processChatInfo(chatWithoutKey("b"));

    expect(
      core
        .getChats()
        .map((c) => c.chatId)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("drops a chat once chatRemoved has pruned it", () => {
    const { core } = makeCore();
    (core as any).processChatInfo(chatWithoutKey("gone"));
    expect(core.getChats().map((c) => c.chatId)).toEqual(["gone"]);

    (core as any).handlePush({
      queryChatsResponse: {
        results: [{ chatId: "gone", status: ChatSyncResult_Status.MISSING }],
      },
    } as any);

    expect(core.getChats()).toEqual([]);
  });
});
