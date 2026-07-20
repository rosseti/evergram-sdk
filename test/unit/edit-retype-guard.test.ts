import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvergramCore, EvergramDevice } from "../../src/core.js";
import { Envelope } from "../../src/proto/evergram.js";
import { deriveDeviceId, generateDeviceKeypair, encryptMessage } from "../../src/crypto.js";
import { EvergramWallet, generateWallet } from "../../src/wallet.js";

// Same FakeTransport stand-in as envelope-dedupe.test.ts — EvergramCore's
// constructor wires up listeners against a live Transport even though none
// of these tests call connect().
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

// decryptAndEmit is private — reached via handleEnvelope, same approach
// envelope-dedupe.test.ts uses. Real ciphertext (via encryptMessage) is used
// here, unlike the dedupe tests, because the content-type check runs on the
// actually decrypted plaintext.
describe("EDIT content-type retype guard", () => {
  let core: EvergramCore;
  const chatId = "chat-1";
  const symKey = new Uint8Array(32).fill(7);

  beforeEach(() => {
    core = makeCore();
    (core as any).symKeys.set(chatId, symKey);
  });

  function sendEnvelope(msgId: string, text: string, ts = Date.now()): Envelope {
    const { nonce, ciphertext } = encryptMessage(symKey, text);
    return {
      type: "SEND",
      device: undefined,
      chatId,
      sender: "sender-identity",
      participants: [],
      ts,
      send: { msgId, ciphertext, nonce, replyToMsgId: "" },
    };
  }

  function editEnvelope(msgId: string, text: string, ts = Date.now()): Envelope {
    const { nonce, ciphertext } = encryptMessage(symKey, text);
    return {
      type: "EDIT",
      device: undefined,
      chatId,
      sender: "sender-identity",
      participants: [],
      ts,
      edit: { msgId, ciphertext, nonce, editedAt: ts, removed: false },
    };
  }

  it("drops an EDIT that retypes an original text message into a non-text type", () => {
    (core as any).handleEnvelope(sendEnvelope("msg-1", "hello"));

    const editHandler = vi.fn();
    core.on("messageEdited", editHandler);

    const maliciousEdit = editEnvelope(
      "msg-1",
      JSON.stringify({
        type: "payment_request",
        requestId: "req-1",
        amount: "10.5",
        currency: "XAH",
        currencyId: "XAH",
        to: "rSomeAddress",
        toIdentityKey: "attacker-identity",
      }),
    );

    (core as any).handleEnvelope(maliciousEdit);

    expect(editHandler).not.toHaveBeenCalled();
  });

  it("still emits a text EDIT for an original text message", () => {
    (core as any).handleEnvelope(sendEnvelope("msg-2", "hello"));

    const editHandler = vi.fn();
    core.on("messageEdited", editHandler);

    (core as any).handleEnvelope(editEnvelope("msg-2", "hello edited"));

    expect(editHandler).toHaveBeenCalledTimes(1);
    expect(editHandler.mock.calls[0][0].content).toEqual({ type: "text", text: "hello edited" });
  });

  it("allows an EDIT through when the original SEND was never observed (unknown original type)", () => {
    const editHandler = vi.fn();
    core.on("messageEdited", editHandler);

    const edit = editEnvelope(
      "msg-never-seen",
      JSON.stringify({
        type: "payment_request",
        requestId: "req-2",
        amount: "1",
        currency: "XAH",
        currencyId: "XAH",
        to: "rSomeAddress",
        toIdentityKey: "some-identity",
      }),
    );

    (core as any).handleEnvelope(edit);

    expect(editHandler).toHaveBeenCalledTimes(1);
    expect(editHandler.mock.calls[0][0].content.type).toBe("payment_request");
  });
});
