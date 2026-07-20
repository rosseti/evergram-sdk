import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvergramCore, EvergramDevice } from "../../src/core.js";
import { deriveDeviceId, generateDeviceKeypair } from "../../src/crypto.js";
import { EvergramWallet, generateWallet } from "../../src/wallet.js";

// Regression test for a crash where connect()'s auth-failure path did
// `this.emit("error", err)` with zero real EventEmitter "error" listeners
// registered — Node throws synchronously in that case, turning it into an
// unhandled rejection inside transport.onOpen's .catch() and leaving
// connect()'s promise permanently unsettled. See core.ts connect()'s
// on("error", onErrorNoop) registration.
let openCb: (() => void) | undefined;

vi.mock("../../src/transport", () => {
  class FakeTransport {
    onMessage() {
      return () => {};
    }
    onOpen(cb: () => void) {
      openCb = cb;
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

describe("connect() error-listener safety", () => {
  beforeEach(() => {
    openCb = undefined;
  });

  it("rejects connect() (does not crash) on auth failure with zero external error listeners", async () => {
    const core = makeCore();
    const authErr = new Error("auth failed");
    vi.spyOn(core as any, "authenticate").mockRejectedValue(authErr);

    // Sanity: no consumer registered an "error" listener, mirroring
    // EvergramBot.start(), which calls core.connect() without one.
    expect(core.listenerCount("error")).toBe(0);

    const connectPromise = core.connect();

    // Fire the deferred transport open callback now that connect() has had a
    // chance to register its internal listeners.
    expect(openCb).toBeTypeOf("function");
    openCb!();

    await expect(connectPromise).rejects.toBe(authErr);
  });

  it('does not let an unrelated background emit("error") reject an in-flight connect()', async () => {
    const core = makeCore();
    let resolveAuth!: () => void;
    vi.spyOn(core as any, "authenticate").mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAuth = resolve;
      }),
    );
    vi.spyOn(core as any, "syncChats").mockResolvedValue(undefined);
    vi.spyOn(core as any, "resyncVisitorSessions").mockResolvedValue(undefined);

    const errorHandler = vi.fn();
    core.on("error", errorHandler); // simulate a consumer that IS listening

    const connectPromise = core.connect();
    openCb!();

    // Simulate an unrelated background failure (e.g. rotation-retry
    // exhaustion) firing mid-connect. It must not resolve/reject connect().
    const backgroundErr = new Error("rotation-retry exhausted");
    core.emit("error", backgroundErr);
    expect(errorHandler).toHaveBeenCalledWith(backgroundErr);

    let settled = false;
    connectPromise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    // Now let auth actually succeed; connect() should resolve normally.
    resolveAuth();
    await expect(connectPromise).resolves.toBeUndefined();
  });
});
