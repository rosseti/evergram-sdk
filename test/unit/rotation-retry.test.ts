import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvergramCore, EvergramDevice } from "../../src/core";
import { EvergramDeviceRevokedError, EvergramRotationError } from "../../src/errors";
import { Envelope } from "../../src/proto/evergram";
import { deriveDeviceId, generateDeviceKeypair } from "../../src/crypto";
import { EvergramWallet, generateWallet } from "../../src/wallet";

// Transport opens a real WebSocket in its constructor's connect() — none of
// these tests call connect(), but EvergramCore's constructor still wires up
// onOpen/onClose/onReconnecting/onMessage listeners against a live Transport
// instance, so it needs a no-op stand-in.
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

// retrySendOnRotationRequired / handleEnvelope are private — this suite
// deliberately reaches into the instance (as any) rather than duplicating
// its wire-protocol setup, mirroring how the DELIVERY envelope branch in
// handleEnvelope() is only reachable from a real server push otherwise.
describe("rotation-retry state machine", () => {
  let core: EvergramCore;
  const chatId = "chat-1";

  beforeEach(() => {
    core = makeCore();
  });

  it("retries once with a new msgId and succeeds", async () => {
    const msgId = "msg-1";
    (core as any).trackPendingSend(msgId, chatId, "hello", undefined, false);

    const rotateSpy = vi.spyOn(core, "rotateChatVersion").mockResolvedValue({} as any);
    const sendSpy = vi.spyOn(core, "sendMessage").mockResolvedValue({
      chatId,
      msgId: "msg-2",
      ts: Date.now(),
    } as any);

    const errorHandler = vi.fn();
    const deliveryHandler = vi.fn();
    core.on("error", errorHandler);
    core.on("delivery", deliveryHandler);

    const swallowed = (core as any).retrySendOnRotationRequired(msgId);
    expect(swallowed).toBe(true);
    // The original entry is removed immediately, synchronously.
    expect((core as any).pendingSends.has(msgId)).toBe(false);

    // The retry itself runs in a detached async IIFE.
    await new Promise((r) => setTimeout(r, 0));

    expect(rotateSpy).toHaveBeenCalledWith(chatId);
    expect(sendSpy).toHaveBeenCalledWith(chatId, "hello", undefined);
    expect(errorHandler).not.toHaveBeenCalled();
    expect(deliveryHandler).not.toHaveBeenCalled();
  });

  it("bounds out after a second consecutive ROTATION_REQUIRED instead of retrying again", async () => {
    const msgId = "msg-1";
    // Simulates the resend already having failed once — trackPendingSend's
    // 4th arg (retried) mirrors what retrySendOnRotationRequired's success
    // path sets on the resent entry.
    (core as any).trackPendingSend(msgId, chatId, "hello", undefined, true);

    const rotateSpy = vi.spyOn(core, "rotateChatVersion");
    const sendSpy = vi.spyOn(core, "sendMessage");

    const errorHandler = vi.fn();
    const deliveryHandler = vi.fn();
    core.on("error", errorHandler);
    core.on("delivery", deliveryHandler);

    const swallowed = (core as any).retrySendOnRotationRequired(msgId);
    expect(swallowed).toBe(true);

    // Terminal path is synchronous — no rotate/resend attempted a second time.
    expect(rotateSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0][0]).toBeInstanceOf(EvergramRotationError);

    expect(deliveryHandler).toHaveBeenCalledTimes(1);
    expect(deliveryHandler.mock.calls[0][0]).toMatchObject({
      chatId,
      msgId,
      status: { ok: false, code: "ROTATION_REQUIRED" },
      eventType: "SEND",
    });
  });

  it("does not retry a send whose device was revoked", async () => {
    const msgId = "msg-1";
    (core as any).trackPendingSend(msgId, chatId, "hello", undefined, false);

    const rotateSpy = vi.spyOn(core, "rotateChatVersion");
    const retrySpy = vi.spyOn(core as any, "retrySendOnRotationRequired");
    const deliveryHandler = vi.fn();
    core.on("delivery", deliveryHandler);

    const env: Envelope = {
      type: "DELIVERY",
      device: undefined,
      chatId,
      sender: "",
      participants: [],
      ts: Date.now(),
      delivery: {
        msgId,
        status: { ok: false, code: "device_revoked", message: "device revoked" },
        ts: Date.now(),
        eventType: "SEND",
      },
    };

    (core as any).handleEnvelope(env);

    // device_revoked never routes through the rotate-and-retry branch.
    expect(retrySpy).not.toHaveBeenCalled();
    expect(rotateSpy).not.toHaveBeenCalled();
    expect((core as any).pendingSends.has(msgId)).toBe(false);

    expect(deliveryHandler).toHaveBeenCalledTimes(1);
    const payload = deliveryHandler.mock.calls[0][0];
    expect(payload.status.ok).toBe(false);
    expect(payload.status.code).toBe("device_revoked");
    // Confirms the underlying error class this code maps to, per errors.ts.
    const { errorFromCode } = await import("../../src/errors");
    expect(errorFromCode(payload.status.code)).toBeInstanceOf(EvergramDeviceRevokedError);
  });
});
