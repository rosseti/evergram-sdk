import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import { EvergramValidationError } from "./errors.js";

// Ports the primitives from webapp/app/lib/crypto.ts and
// webapp/app/ui/providers/EvergramProvider.tsx's chat-key derivation —
// same algorithms (tweetnacl secretbox/box), no browser dependency.

export const hexToBytes = (hex: string): Uint8Array => {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.substr(i * 2, 2), 16);
  return out;
};

export const bytesToHex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

export function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export function generateNonce(): string {
  return Buffer.from(nacl.randomBytes(24)).toString("hex");
}

export function generateMsgId(): string {
  return Buffer.from(nacl.randomBytes(32)).toString("hex");
}

export function encryptMessage(symKey: Uint8Array, text: string): { nonce: string; ciphertext: string } {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const msg = new TextEncoder().encode(text);
  const box = nacl.secretbox(msg, nonce, symKey);

  if (!box) {
    throw new EvergramValidationError("encryption_failed", "Failed to encrypt message (nacl.secretbox)");
  }

  return {
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(box),
  };
}

export function decryptMessage(symKey: Uint8Array, nonceB64: string, ciphertextB64: string): string | null {
  const nonce = base64ToBytes(nonceB64);
  const box = base64ToBytes(ciphertextB64);

  const opened = nacl.secretbox.open(box, nonce, symKey);
  return opened ? new TextDecoder().decode(opened) : null;
}

// Derives a chat's raw symmetric key from the sealed envelope the gateway
// produces for this device (chat.symKeyEncrypted[identityKey].devices[deviceId]).
// Mirrors EvergramProvider.tsx's processChat() box-opening exactly: the
// gateway seals the key with nacl.box for each registered device public key,
// only this device's matching X25519 secret key can open it.
export function openSealedSymKey(
  sealed: { ciphertext: string; nonce: string; ephemeralPubkey: string },
  devicePrivHex: string
): Uint8Array | null {
  return nacl.box.open(
    base64ToBytes(sealed.ciphertext),
    base64ToBytes(sealed.nonce),
    base64ToBytes(sealed.ephemeralPubkey),
    hexToBytes(devicePrivHex)
  );
}

export function generateDeviceKeypair(): { pubHex: string; privHex: string } {
  const kp = nacl.box.keyPair();
  return {
    pubHex: bytesToHex(kp.publicKey),
    privHex: bytesToHex(kp.secretKey),
  };
}

// Derives the X25519 public key matching a device private key — used to
// catch a corrupted/mismatched devicePrivHex (e.g. truncated or bit-flipped
// wherever the caller persisted it) at construction time, before it
// silently breaks every chat key derivation later. Throws (via tweetnacl's
// own length check) if the hex doesn't decode to a 32-byte key.
export function deriveDevicePubHex(devicePrivHex: string): string {
  const keyPair = nacl.box.keyPair.fromSecretKey(hexToBytes(devicePrivHex));
  return bytesToHex(keyPair.publicKey);
}

// Mirrors webapp/app/lib/device-storage.ts's deriveDeviceId exactly — the
// device_id sent in every message must match sha256(devicePubHex) truncated
// to 32 hex chars, or the gateway/contract reject it as invalid_device.
export function deriveDeviceId(devicePubHex: string): string {
  const normalized = devicePubHex.toLowerCase().replace(/^0x/, "");

  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length < 64) {
    throw new EvergramValidationError("invalid_device_pubkey_format");
  }

  const hash = createHash("sha256").update(Buffer.from(normalized, "hex")).digest();
  return Buffer.from(hash).toString("hex").slice(0, 32);
}
