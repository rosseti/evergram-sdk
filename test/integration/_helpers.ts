import { EvergramDevice } from "../../src/core.js";
import { deriveDeviceId, generateDeviceKeypair } from "../../src/crypto.js";
import { ChainFamily, ClientMessage } from "../../src/proto/evergram.js";
import {
  EvergramWallet,
  generateWallet,
  signAuthChallenge,
  walletFromSeed,
} from "../../src/wallet.js";

// Override with EVERGRAM_TEST_WS_URL if your local stack exposes the
// gateway somewhere other than the docker-compose.yml default.
export const WS_URL = process.env.EVERGRAM_TEST_WS_URL ?? "ws://localhost:9000/api/ws";

export function freshIdentity(): { wallet: EvergramWallet; device: EvergramDevice } {
  const wallet = generateWallet();
  const { pubHex, privHex } = generateDeviceKeypair();
  const device: EvergramDevice = {
    deviceId: deriveDeviceId(pubHex),
    devicePubHex: pubHex,
    devicePrivHex: privHex,
  };
  return { wallet, device };
}

// group:create is gated behind the beta/ga/admin tiers (see
// contract/contract/access.config.json) — the default local "early" tier a
// freshIdentity() wallet starts in can't create groups. Tests that need a
// group (updateChatRoles, setChatMode, leaveChat's success path) call this
// and skip themselves if no such wallet is configured locally, rather than
// failing on environments that haven't set one up. Reuses the same wallet
// address across runs (its tier was granted out-of-band), so prefer an
// `admin`-tier seed (no devices/chats limit) over `beta` (devices: 3,
// chats: 20) to avoid exhausting those limits over repeated local runs.
export function adminIdentityOrSkip(): { wallet: EvergramWallet; device: EvergramDevice } | null {
  const seed = process.env.EVERGRAM_TEST_ADMIN_SEED;
  if (!seed) return null;

  const wallet = walletFromSeed(seed);
  const { pubHex, privHex } = generateDeviceKeypair();
  const device: EvergramDevice = {
    deviceId: deriveDeviceId(pubHex),
    devicePubHex: pubHex,
    devicePrivHex: privHex,
  };
  return { wallet, device };
}

export function buildAuthMessage(
  wallet: EvergramWallet,
  device: EvergramDevice,
  nonce: string,
): ClientMessage {
  const proof = signAuthChallenge(wallet, device.deviceId, nonce);
  return ClientMessage.create({
    auth: {
      identity: { chainFamily: ChainFamily.XRPL, address: wallet.address },
      proof: { signedMessage: proof },
      device: { deviceId: device.deviceId, devicePubHex: device.devicePubHex },
    },
  });
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
