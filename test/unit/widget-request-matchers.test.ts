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
});
