import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { EvergramCore, EvergramDevice } from "../../src/core.js";
import { deriveDeviceId, generateDeviceKeypair } from "../../src/crypto.js";
import { EvergramWallet, generateWallet } from "../../src/wallet.js";
import { AccountPresence_Status } from "../../src/proto/evergram.js";
import { Transport } from "../../src/transport.js";

// watchIdentities/unwatchIdentities let a consumer (e.g. a TUI's chat
// screen) ask the gateway to start/stop pushing "accountPresence" events for
// a set of identities — mirrors syncChats()'s fire-and-forget contract:
// never throws, surfaces failure via "error", and the actual result arrives
// later as an unsolicited push handled by handlePush().

class FakeTransport {
  send = vi.fn();
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

function makeCore(): { core: EvergramCore; transport: FakeTransport } {
  const { wallet, device } = freshIdentity();
  const transport = new FakeTransport();
  const core = new EvergramCore({
    url: "ws://localhost:9000/api/ws",
    wallet,
    device,
    transport: transport as unknown as Transport,
  });
  return { core, transport };
}

describe("watchIdentities / unwatchIdentities", () => {
  it("sends a watchIdentities request once authenticated", () => {
    const { core, transport } = makeCore();
    (core as any).authenticated = true;

    core.watchIdentities(["1:rAlice"]);

    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ watchIdentities: { identities: ["1:rAlice"] } }),
    );
  });

  it("sends an unwatchIdentities request once authenticated", () => {
    const { core, transport } = makeCore();
    (core as any).authenticated = true;

    core.unwatchIdentities(["1:rAlice"]);

    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ unwatchIdentities: { identities: ["1:rAlice"] } }),
    );
  });

  it("is a no-op for an empty identity list", () => {
    const { core, transport } = makeCore();
    (core as any).authenticated = true;

    core.watchIdentities([]);
    core.unwatchIdentities([]);

    expect(transport.send).not.toHaveBeenCalled();
  });

  it("never throws before authentication — surfaces via the error event instead", () => {
    const { core, transport } = makeCore();
    const errorHandler = vi.fn();
    core.on("error", errorHandler);

    expect(() => core.watchIdentities(["1:rAlice"])).not.toThrow();

    expect(transport.send).not.toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalledTimes(1);
  });
});

describe("accountPresence event", () => {
  it("emits online: true for an ONLINE push", () => {
    const { core } = makeCore();
    const handler = vi.fn();
    core.on("accountPresence", handler);

    (core as any).handlePush({
      accountPresence: { identityKey: "1:rAlice", status: AccountPresence_Status.ONLINE, ts: 123 },
    } as any);

    expect(handler).toHaveBeenCalledWith({ identityKey: "1:rAlice", online: true, ts: 123 });
  });

  it("emits online: false for an OFFLINE push", () => {
    const { core } = makeCore();
    const handler = vi.fn();
    core.on("accountPresence", handler);

    (core as any).handlePush({
      accountPresence: { identityKey: "1:rAlice", status: AccountPresence_Status.OFFLINE, ts: 456 },
    } as any);

    expect(handler).toHaveBeenCalledWith({ identityKey: "1:rAlice", online: false, ts: 456 });
  });

  it("does not emit when the push carries no accountPresence field", () => {
    const { core } = makeCore();
    const handler = vi.fn();
    core.on("accountPresence", handler);

    (core as any).handlePush({} as any);

    expect(handler).not.toHaveBeenCalled();
  });
});
