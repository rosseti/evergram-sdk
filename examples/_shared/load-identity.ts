import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  EvergramDevice,
  EvergramWallet,
  generateDeviceKeypair,
  generateWallet,
  deriveDeviceId,
  walletFromSeed,
} from "../../src";

interface StoredIdentity {
  walletSeed: string;
  devicePubHex: string;
  devicePrivHex: string;
}

// The SDK deliberately does not persist keys for you (see README "Device
// keys & backup" — there is no recovery path in the protocol if you lose
// these). This loads-or-creates a JSON file next to the example so running
// it twice reuses the same wallet/device instead of orphaning chat history
// on every restart. A real bot should use a safer secret store than a
// plaintext file.
export function loadOrCreateIdentity(path: string): { wallet: EvergramWallet; device: EvergramDevice } {
  if (existsSync(path)) {
    const stored: StoredIdentity = JSON.parse(readFileSync(path, "utf8"));
    const wallet = walletFromSeed(stored.walletSeed);
    const device: EvergramDevice = {
      deviceId: deriveDeviceId(stored.devicePubHex),
      devicePubHex: stored.devicePubHex,
      devicePrivHex: stored.devicePrivHex,
    };
    return { wallet, device };
  }

  const wallet = generateWallet();
  const { pubHex, privHex } = generateDeviceKeypair();
  const device: EvergramDevice = {
    deviceId: deriveDeviceId(pubHex),
    devicePubHex: pubHex,
    devicePrivHex: privHex,
  };

  const stored: StoredIdentity = {
    walletSeed: wallet.seed,
    devicePubHex: pubHex,
    devicePrivHex: privHex,
  };
  writeFileSync(path, JSON.stringify(stored, null, 2));

  console.log(`[identity] Created new bot identity at ${path}`);
  console.log(`[identity] Address: ${wallet.address}`);
  console.log(`[identity] Fund/register this address before authenticating, then invite it to a chat.`);

  return { wallet, device };
}
