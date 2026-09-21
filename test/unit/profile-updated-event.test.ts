import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { EvergramCore, EvergramDevice } from "../../src/core.js";
import { deriveDeviceId, generateDeviceKeypair } from "../../src/crypto.js";
import { EvergramWallet, generateWallet } from "../../src/wallet.js";
import { parseIdentityKey } from "../../src/identity.js";
import { Transport } from "../../src/transport.js";

// The gateway pushes profile_updated when a contact changes their profile
// (e.g. /nick); core surfaces it as "profileUpdated" so clients can refresh
// cached display names live.

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

describe("profileUpdated event", () => {
  it("emits the wire-format identity key and profile fields", () => {
    const { core } = makeCore();
    const handler = vi.fn();
    core.on("profileUpdated", handler);

    (core as any).handlePush({
      profileUpdated: {
        profile: {
          identity: parseIdentityKey("1:rAlice"),
          nickname: "alice2",
          avatarUrl: "",
          bio: "hi",
          updatedAt: 1,
          isAdmin: false,
        },
      },
    } as any);

    expect(handler).toHaveBeenCalledWith({
      identityKey: "1:rAlice",
      nickname: "alice2",
      avatarUrl: "",
      bio: "hi",
      isAdmin: false,
    });
  });

  it("does not emit when the push carries no profile identity", () => {
    const { core } = makeCore();
    const handler = vi.fn();
    core.on("profileUpdated", handler);

    (core as any).handlePush({ profileUpdated: {} } as any);
    (core as any).handlePush({} as any);

    expect(handler).not.toHaveBeenCalled();
  });
});
