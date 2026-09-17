import { beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import { EvergramCore, EvergramDevice } from "../../src/core.js";
import { Envelope } from "../../src/proto/evergram.js";
import { deriveDeviceId, encryptMessage, generateDeviceKeypair } from "../../src/crypto.js";
import { EvergramWallet, generateWallet } from "../../src/wallet.js";

// See rotation-retry.test.ts for why this stand-in is needed: EvergramCore's
// constructor wires up listeners against a live Transport instance even
// though none of these tests call connect().
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
    // A real symKey (seeded in beforeEach) with garbled ciphertext just
    // fails to decrypt (decryptMessage returns null, see crypto.ts) rather
    // than throwing — this env is a stand-in for a stale-key SEND, not a
    // malformed one.
    const env = sendEnvelope("msg-1", "nonce-1");

    (core as any).handleEnvelope(env);
    (core as any).handleEnvelope(env);

    // A SEND that fails to decrypt is deliberately left out of
    // seenEnvelopeKeys (see decryptAndEmit's text === null branch) so a
    // later, correctly-keyed redelivery of the same envelope isn't mistaken
    // for a duplicate of a failed attempt — see the "stale key" test below.
    // What must still hold here: it's queued at most once per delivery, no
    // more.
    expect((core as any).seenEnvelopeKeys.size).toBe(0);
    expect((core as any).pendingEnvelopes.get(chatId)?.length).toBe(2);
    expect(messageHandler).not.toHaveBeenCalled();
  });

  it("queues an undecryptable SEND (stale key) and replays it once the chat's key is refreshed", () => {
    const messageHandler = vi.fn();
    const staleHandler = vi.fn();
    core.on("message", messageHandler);
    core.on("chatKeyStale", staleHandler);

    const env = sendEnvelope("msg-1", "nonce-1");
    (core as any).handleEnvelope(env);

    // Decrypt failed (garbled ciphertext under the seeded key) — the
    // message must NOT have been silently emitted as empty text, the app
    // must have been told the key is stale, and the envelope must still be
    // waiting for a working key.
    expect(messageHandler).not.toHaveBeenCalled();
    expect(staleHandler).toHaveBeenCalledWith({ chatId, msgId: "msg-1" });
    expect((core as any).pendingEnvelopes.get(chatId)).toHaveLength(1);

    // Simulate the chat's key being refreshed (a rotation broadcast or a
    // plain resync both end up here, via processChatInfo -> drainPending)
    // with a key this envelope actually decrypts under.
    const realKey = nacl.randomBytes(32);
    const { nonce, ciphertext } = encryptMessage(realKey, "oi, cheguei com um dispositivo novo");

    const freshEnv = sendEnvelope("msg-2", nonce);
    freshEnv.send!.ciphertext = ciphertext;
    (core as any).symKeys.set(chatId, realKey);
    (core as any).drainPending(chatId);

    // The stale queued envelope (msg-1) is still garbled under the new key
    // too in this test (its ciphertext was never re-encrypted) — it's
    // expected to fail again and re-queue; what matters is it was retried
    // rather than dropped forever, and a *new*, decryptable delivery for the
    // same chat proceeds normally once the key is current.
    (core as any).handleEnvelope(freshEnv);
    expect(messageHandler).toHaveBeenCalledWith(
      expect.objectContaining({ msgId: "msg-2", text: "oi, cheguei com um dispositivo novo" }),
    );
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
