import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvergramCore, EvergramDevice } from "../../src/core.js";
import { deriveDeviceId, generateDeviceKeypair } from "../../src/crypto.js";
import { EvergramConnectionError } from "../../src/errors.js";
import { EvergramWallet, generateWallet } from "../../src/wallet.js";

// Regression test for transport.onClose now rejecting every in-flight
// request immediately (see core.ts's onClose handler) instead of leaving
// each one to hang until its own requestTimeoutMs timer fires — up to 90s
// for some calls. Mirrors the webapp client's inflightAborters behavior.
let closeCb: (() => void) | undefined;

vi.mock("../../src/transport", () => {
  class FakeTransport {
    onMessage() {
      return () => {};
    }
    onOpen() {
      return () => {};
    }
    onClose(cb: () => void) {
      closeCb = cb;
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
  const core = new EvergramCore({ url: "ws://localhost:9000/api/ws", wallet, device });
  // connect() itself pulls in the full auth flow; the onClose wiring we're
  // testing is installed synchronously in the constructor, so registering
  // via the constructor's transport.onClose(...) call is all we need.
  return core;
}

describe("transport disconnect rejects in-flight requests", () => {
  beforeEach(() => {
    closeCb = undefined;
  });

  it("rejects a pending request with EvergramConnectionError when the transport closes", async () => {
    const core = makeCore();
    expect(closeCb).toBeTypeOf("function");

    // Directly register a pending waiter the same way request() does
    // internally, without needing a real gateway round-trip.
    const pending = (core as any).waitForMessage("createChatResponse", 90_000);

    closeCb!();

    await expect(pending).rejects.toBeInstanceOf(EvergramConnectionError);
    await expect(pending).rejects.toMatchObject({ code: "connection_lost" });
  });

  it("does not throw or double-reject on a second disconnect once pending requests are already cleared", async () => {
    const core = makeCore();
    const pending = (core as any).waitForMessage("createChatResponse", 90_000);

    closeCb!();
    await expect(pending).rejects.toBeInstanceOf(EvergramConnectionError);

    // pendingRequests/pendingByRequestId are already empty at this point —
    // firing onClose again must be a harmless no-op, not a crash or a
    // second rejection attempt on an already-settled promise.
    expect(() => closeCb!()).not.toThrow();
  });
});
