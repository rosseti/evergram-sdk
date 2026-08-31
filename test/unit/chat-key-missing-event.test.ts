import { describe, expect, it, vi } from "vitest";
import { EvergramCore, EvergramDevice } from "../../src/core.js";
import { deriveDeviceId, generateDeviceKeypair } from "../../src/crypto.js";
import { generateWallet } from "../../src/wallet.js";
import { identityKey } from "../../src/identity.js";
import { ChainFamily, ChatInfo } from "../../src/proto/evergram.js";
import { bytesToBase64, hexToBytes } from "../../src/crypto.js";
import nacl from "tweetnacl";

// The SDK's only automatic rotation trigger is a failed send, so a bot that
// only listens had no way to learn that a chat was undecryptable:
// processChatInfo returned silently when this device had no sealed key, and
// envelopes just piled up in pendingEnvelopes until the cap dropped them.

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

// The gateway seals chat keys; the SDK only opens them, so the test has to
// build the sealed envelope openSealedSymKey expects.
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

describe("chatKeyMissing", () => {
  it("emits when this device has no sealed key for the chat", () => {
    const { core } = makeCore();
    const handler = vi.fn();
    core.on("chatKeyMissing", handler);

    (core as any).processChatInfo(chatWithoutKey("no-key"));

    expect(handler).toHaveBeenCalledWith({ chatId: "no-key" });
  });

  it("emits once per chat, not once per sync", () => {
    const { core } = makeCore();
    const handler = vi.fn();
    core.on("chatKeyMissing", handler);

    // A reconnecting bot re-runs syncChats, and processChatInfo runs again
    // for every chat each time.
    for (let i = 0; i < 5; i++) (core as any).processChatInfo(chatWithoutKey("no-key"));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("emits again if the key is delivered and later goes missing", () => {
    const { core, device, self } = makeCore();
    const handler = vi.fn();
    core.on("chatKeyMissing", handler);

    const chatId = "recovers";
    (core as any).processChatInfo(chatWithoutKey(chatId));
    expect(handler).toHaveBeenCalledTimes(1);

    const symKeyHex = "aa".repeat(32);
    const sealed = sealForDevice(symKeyHex, device.devicePubHex);
    (core as any).processChatInfo({
      chatId,
      chatVersion: 2,
      participants: [],
      symKeyEncrypted: { [self]: { devices: { [device.deviceId]: sealed } } },
    } as unknown as ChatInfo);

    // Still one: the key arrived, so nothing new to report.
    expect(handler).toHaveBeenCalledTimes(1);

    // A rotation this device was left out of (e.g. it was revoked and
    // re-registered) puts it back into the missing state.
    (core as any).processChatInfo(chatWithoutKey(chatId));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not emit for a chat this device can decrypt", () => {
    const { core, device, self } = makeCore();
    const handler = vi.fn();
    core.on("chatKeyMissing", handler);

    const symKeyHex = "bb".repeat(32);
    const sealed = sealForDevice(symKeyHex, device.devicePubHex);
    (core as any).processChatInfo({
      chatId: "has-key",
      chatVersion: 1,
      participants: [],
      symKeyEncrypted: { [self]: { devices: { [device.deviceId]: sealed } } },
    } as unknown as ChatInfo);

    expect(handler).not.toHaveBeenCalled();
  });
});
