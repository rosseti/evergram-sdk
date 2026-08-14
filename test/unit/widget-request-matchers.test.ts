import { beforeEach, describe, expect, it } from "vitest";
import { EvergramCore, EvergramDevice } from "../../src/core.js";
import { Transport } from "../../src/transport.js";
import { deriveDeviceId, generateDeviceKeypair } from "../../src/crypto.js";
import { EvergramWallet, generateWallet } from "../../src/wallet.js";

// Same FakeTransport shape as rotation-retry.test.ts, plus a way to push a
// fake ServerMessage to whatever handler(s) EvergramCore registered via
// onMessage — mirrors webapp's socket-client mock's triggerMessage().
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
  sent: any[] = [];
  send(msg: any) {
    this.sent.push(msg);
  }
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

function makeCore(transport: FakeTransport): EvergramCore {
  const { wallet, device } = freshIdentity();
  return new EvergramCore({
    url: "ws://localhost:9000/api/ws",
    wallet,
    device,
    transport: transport as unknown as Transport,
  });
}

// getWidgetInfo/updateWidgetConfig previously had no field on their response
// to disambiguate concurrent same-type calls (unlike every other
// requestWithReauth() call, which got matchers in the 2026-07-20 security
// pass). GetWidgetInfoResponse/UpdateWidgetConfigResponse now echo
// widget_id specifically to close that gap — this suite is the regression
// guard for it.
describe("widget request matchers", () => {
  let transport: FakeTransport;
  let core: EvergramCore;

  beforeEach(() => {
    transport = new FakeTransport();
    core = makeCore(transport);
    // These tests exercise request-matcher disambiguation directly, bypassing
    // the real auth handshake — mark the connection authenticated so the
    // session-readiness gate in request() (assertReadyToSend) doesn't reject
    // the calls under test. See connect-error-safety.test.ts and friends for
    // the same "poke the private flag" pattern used elsewhere in this suite.
    (core as any).authenticated = true;
  });

  it("getWidgetInfo: two concurrent calls for different widgets don't cross-resolve when responses arrive out of order", async () => {
    const widgetACall = core.getWidgetInfo("widget-a");
    const widgetBCall = core.getWidgetInfo("widget-b");

    // Deliver widget-b's response FIRST even though widget-a was requested first.
    transport.trigger({
      getWidgetInfoResponse: {
        status: { ok: true },
        enabled: true,
        ownerIdentityKey: "owner-b",
        devices: [],
        widgetId: "widget-b",
      },
    });
    transport.trigger({
      getWidgetInfoResponse: {
        status: { ok: true },
        enabled: true,
        ownerIdentityKey: "owner-a",
        devices: [],
        widgetId: "widget-a",
      },
    });

    const [a, b] = await Promise.all([widgetACall, widgetBCall]);
    expect(a.ownerIdentityKey).toBe("owner-a");
    expect(b.ownerIdentityKey).toBe("owner-b");
  });

  it("updateWidgetConfig: two concurrent calls for different widgets don't cross-resolve when responses arrive out of order", async () => {
    const callA = core.updateWidgetConfig("widget-a", {} as any);
    const callB = core.updateWidgetConfig("widget-b", {} as any);

    transport.trigger({
      updateWidgetConfigResponse: { status: { ok: true }, widgetId: "widget-b" },
    });
    transport.trigger({
      updateWidgetConfigResponse: { status: { ok: true }, widgetId: "widget-a" },
    });

    await expect(callA).resolves.toMatchObject({ widgetId: "widget-a" });
    await expect(callB).resolves.toMatchObject({ widgetId: "widget-b" });
  });

  // requestId (ClientMessage.request_id, echoed back as ServerMessage.
  // request_id) is now core.ts's primary correlation mechanism — it's
  // authoritative before any matcher/type-based guessing runs. This test
  // forces both concurrent calls to the SAME widgetId, so the widget_id
  // matcher above genuinely cannot tell them apart; only requestId can.
  it("requestId disambiguates two concurrent calls the widget_id matcher cannot (same widgetId)", async () => {
    const first = core.getWidgetInfo("widget-a");
    const second = core.getWidgetInfo("widget-a");

    const [firstRequestId, secondRequestId] = transport.sent.map((m) => m.requestId);
    expect(firstRequestId).toBeTruthy();
    expect(secondRequestId).toBeTruthy();
    expect(firstRequestId).not.toBe(secondRequestId);

    // Deliver the SECOND call's response first, tagged with its own
    // requestId — resolution must follow the id, not arrival order.
    transport.trigger({
      requestId: secondRequestId,
      getWidgetInfoResponse: {
        status: { ok: true },
        enabled: true,
        ownerIdentityKey: "owner-second",
        devices: [],
        widgetId: "widget-a",
      },
    });
    transport.trigger({
      requestId: firstRequestId,
      getWidgetInfoResponse: {
        status: { ok: true },
        enabled: true,
        ownerIdentityKey: "owner-first",
        devices: [],
        widgetId: "widget-a",
      },
    });

    const [firstResp, secondResp] = await Promise.all([first, second]);
    expect(firstResp.ownerIdentityKey).toBe("owner-first");
    expect(secondResp.ownerIdentityKey).toBe("owner-second");
  });

  it("a requestId-tagged bare error rejects only the matching call, leaving the other concurrent call pending", async () => {
    const first = core.getWidgetInfo("widget-a");
    const second = core.getWidgetInfo("widget-b");

    const [firstRequestId] = transport.sent.map((m) => m.requestId);

    transport.trigger({
      requestId: firstRequestId,
      error: { code: "INTERNAL", message: "boom" },
    });
    transport.trigger({
      getWidgetInfoResponse: {
        status: { ok: true },
        enabled: true,
        ownerIdentityKey: "owner-b",
        devices: [],
        widgetId: "widget-b",
      },
    });

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toMatchObject({ ownerIdentityKey: "owner-b" });
  });
});
