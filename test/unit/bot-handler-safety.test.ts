import { describe, expect, it } from "vitest";
import { EvergramBot } from "../../src/bot.js";
import { EvergramDevice } from "../../src/core.js";
import { Transport } from "../../src/transport.js";
import { deriveDeviceId, generateDeviceKeypair } from "../../src/crypto.js";
import { EvergramWallet, generateWallet } from "../../src/wallet.js";

// Same FakeTransport shape as core.test's rotation-retry.test.ts / SDK's
// widget-request-matchers.test.ts.
class FakeTransport {
  private handlers = new Set<(m: any) => void>();
  onMessage(cb: (m: any) => void) {
    this.handlers.add(cb);
    return () => this.handlers.delete(cb);
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
    return true;
  }
  connect() {
    return Promise.resolve();
  }
  close() {}
  send() {}
  trigger(msg: any) {
    this.handlers.forEach((h) => h(msg));
  }
}

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

function makeBot(transport: FakeTransport): EvergramBot {
  const { wallet, device } = freshIdentity();
  return new EvergramBot({
    url: "ws://localhost:9000/api/ws",
    wallet,
    device,
    transport: transport as unknown as Transport,
  });
}

// bindEvent's doc comment promises a bot author never needs their own
// try/catch around a handler — a thrown/rejected handler routes to the
// core's "error" event instead of crashing the process. That guarantee
// previously only held for a *rejected returned promise*; a synchronous
// throw (valid per the handler's void | Promise<void> signature) escaped
// the wrapper entirely. Fixed 2026-07-20 — this is the regression guard.
const FAKE_MESSAGE = {
  chatId: "chat-1",
  sender: "someone",
  msgId: "msg-1",
  ts: Date.now(),
  text: "hi",
  content: { type: "text", text: "hi" },
};

describe("EvergramBot handler safety", () => {
  it("routes a handler's synchronous throw to the 'error' event instead of crashing", () => {
    const bot = makeBot(new FakeTransport());

    const errors: unknown[] = [];
    bot.core.on("error", (err) => errors.push(err));

    bot.onMessage(() => {
      throw new Error("sync boom");
    });

    expect(() => bot.core.emit("message", FAKE_MESSAGE as any)).not.toThrow();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("sync boom");
  });

  it("routes a handler's rejected promise to the 'error' event instead of an unhandled rejection", async () => {
    const bot = makeBot(new FakeTransport());

    const errors: Error[] = [];
    bot.core.on("error", (err) => errors.push(err));

    bot.onMessage(async () => {
      throw new Error("async boom");
    });

    bot.core.emit("message", FAKE_MESSAGE as any);

    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("async boom");
  });
});
