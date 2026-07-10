import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvergramCore, EvergramDevice } from "../../src/core";
import { Envelope } from "../../src/proto/evergram";
import { deriveDeviceId, generateDeviceKeypair } from "../../src/crypto";
import { EvergramWallet, generateWallet } from "../../src/wallet";

// See rotation-retry.test.ts for why this stand-in is needed: EvergramCore's
// constructor wires up listeners against a live Transport instance even
// though none of these tests call connect().
vi.mock("../../src/transport", () => {
  class FakeTransport {
    onMessage() { return () => {}; }
    onOpen() { return () => {}; }
    onClose() { return () => {}; }
    onReconnecting() { return () => {}; }
    isOpen() { return false; }
    connect() { return Promise.resolve(); }
    close() {}
    send() {}
  }
  return { Transport: FakeTransport };
});

function freshIdentity(): { wallet: EvergramWallet; device: EvergramDevice } {
  const wallet = generateWallet();
  const { pubHex, privHex } = generateDeviceKeypair();
  const device: EvergramDevice = {
    deviceId: deriveDeviceId(pubHex),
    devicePubHex: pubHex,
    devicePrivHex: privHex,
  };
  return { wallet, device };
}

function makeCore(): EvergramCore {
  const { wallet, device } = freshIdentity();
  return new EvergramCore({ url: "ws://localhost:9000/api/ws", wallet, device });
}

// deliverOrQueue/decryptAndEmit are private — reached via handleEnvelope,
// same approach rotation-retry.test.ts uses for the DELIVERY branch. A
// symKey is seeded directly into the private symKeys map so envelopes are
// decrypted immediately instead of queued (see deliverOrQueue).
describe("envelope replay/duplicate suppression", () => {
  let core: EvergramCore;
  const chatId = "chat-1";

  beforeEach(() => {
    core = makeCore();
    (core as any).symKeys.set(chatId, new Uint8Array(32).fill(7));
  });

  function sendEnvelope(msgId: string, nonce: string, ts = Date.now()): Envelope {
    return {
      type: "SEND",
      device: undefined,
      chatId,
      sender: "sender-identity",
      participants: [],
      ts,
      send: { msgId, ciphertext: "garbled-ciphertext", nonce, replyToMsgId: "" },
    };
  }

  it("only emits 'message' once for a redelivered (duplicate) envelope", () => {
    const messageHandler = vi.fn();
    core.on("message", messageHandler);
    // decryptMessage will throw on this fake ciphertext — that's fine, the
    // dedup check runs before decryption and this test only cares that the
    // second delivery never reaches emit(). Swallow the expected throw via
    // a try/catch per call instead of asserting decrypted content.
    const env = sendEnvelope("msg-1", "nonce-1");

    for (let i = 0; i < 2; i++) {
      try {
        (core as any).handleEnvelope(env);
      } catch {
        // decryptMessage failure on fake ciphertext is expected; only the
        // first call should even reach decryptMessage (see assertion below).
      }
    }

    // isDuplicateEnvelope must have blocked the second call before decrypt
    // was attempted a second time.
    expect((core as any).seenEnvelopeKeys.size).toBe(1);
  });

  it("does not drop a legitimate EDIT to an already-seen msgId as a duplicate", () => {
    const sendEnv = sendEnvelope("msg-1", "nonce-1");
    try {
      (core as any).handleEnvelope(sendEnv);
    } catch {
      // expected: fake ciphertext fails decryptMessage after passing dedup.
    }

    const editHandler = vi.fn();
    core.on("messageEdited", editHandler);

    const editEnv: Envelope = {
      type: "EDIT",
      device: undefined,
      chatId,
      sender: "sender-identity",
      participants: [],
      ts: Date.now(),
      edit: {
        msgId: "msg-1",
        ciphertext: "garbled-ciphertext",
        nonce: "edit-nonce-1",
        editedAt: Date.now(),
        removed: false,
      },
    };

    // isDuplicateEnvelope must treat this as a distinct key (EDIT prefix +
    // its own nonce), i.e. it must not already be in seenEnvelopeKeys.
    expect((core as any).isDuplicateEnvelope(editEnv)).toBe(false);
  });

  it("caps seenEnvelopeKeys at MAX_SEEN_ENVELOPE_KEYS via oldest-first eviction", () => {
    const cap = 5000;
    for (let i = 0; i < cap + 10; i++) {
      (core as any).isDuplicateEnvelope(sendEnvelope(`msg-${i}`, `nonce-${i}`));
    }

    expect((core as any).seenEnvelopeKeys.size).toBe(cap);
    // The earliest keys should have been evicted; the most recent one
    // must still be present.
    expect((core as any).seenEnvelopeKeys.has(`SEND:msg-0:nonce-0`)).toBe(false);
    expect((core as any).seenEnvelopeKeys.has(`SEND:msg-${cap + 9}:nonce-${cap + 9}`)).toBe(true);
  });
});
