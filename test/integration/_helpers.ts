import { EvergramDevice } from "../../src/core";
import { deriveDeviceId, generateDeviceKeypair } from "../../src/crypto";
import { ChainFamily, ClientMessage } from "../../src/proto/evergram";
import { EvergramWallet, generateWallet, signAuthChallenge } from "../../src/wallet";

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

export function buildAuthMessage(
  wallet: EvergramWallet,
  device: EvergramDevice,
  nonce: string
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
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
