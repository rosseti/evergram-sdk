import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import {
  bytesToBase64,
  decryptMessage,
  deriveDeviceId,
  encryptMessage,
  generateDeviceKeypair,
  hexToBytes,
  openSealedSymKey,
} from "../../src/crypto.js";

describe("crypto", () => {
  it("generateDeviceKeypair produces 32-byte X25519 keys as hex", () => {
    const { pubHex, privHex } = generateDeviceKeypair();
    expect(pubHex).toHaveLength(64);
    expect(privHex).toHaveLength(64);
  });

  describe("hexToBytes", () => {
    it("decodes valid hex, with or without a 0x prefix", () => {
      expect(hexToBytes("00ff")).toEqual(new Uint8Array([0x00, 0xff]));
      expect(hexToBytes("0x00ff")).toEqual(new Uint8Array([0x00, 0xff]));
    });

    it("rejects malformed hex instead of silently parsing it to 0 bytes", () => {
      expect(() => hexToBytes("not-hex")).toThrow(/Not a valid hex string/);
      expect(() => hexToBytes("zz")).toThrow(/Not a valid hex string/);
    });

    it("rejects an odd-length string instead of silently truncating the last nibble", () => {
      expect(() => hexToBytes("abc")).toThrow(/Not a valid hex string/);
    });
  });

  describe("deriveDeviceId", () => {
    it("is deterministic for the same public key", () => {
      const { pubHex } = generateDeviceKeypair();
      expect(deriveDeviceId(pubHex)).toBe(deriveDeviceId(pubHex));
    });

    it("differs for different public keys", () => {
      const a = generateDeviceKeypair();
      const b = generateDeviceKeypair();
      expect(deriveDeviceId(a.pubHex)).not.toBe(deriveDeviceId(b.pubHex));
    });

    it("rejects malformed public keys instead of silently hashing garbage", () => {
      expect(() => deriveDeviceId("not-hex")).toThrow("invalid_device_pubkey_format");
      expect(() => deriveDeviceId("ab")).toThrow("invalid_device_pubkey_format");
    });
  });

  describe("encryptMessage / decryptMessage", () => {
    it("round-trips plaintext through a random symmetric key", () => {
      const symKey = nacl.randomBytes(32);
      const { nonce, ciphertext } = encryptMessage(symKey, "ola evergram");
      expect(decryptMessage(symKey, nonce, ciphertext)).toBe("ola evergram");
    });

    it("fails closed (returns null) when decrypting with the wrong key", () => {
      const { nonce, ciphertext } = encryptMessage(nacl.randomBytes(32), "secret");
      expect(decryptMessage(nacl.randomBytes(32), nonce, ciphertext)).toBeNull();
    });

    it("fails closed (returns null) on a tampered ciphertext", () => {
      const symKey = nacl.randomBytes(32);
      const { nonce, ciphertext } = encryptMessage(symKey, "secret");
      const tampered = bytesToBase64(nacl.randomBytes(Buffer.from(ciphertext, "base64").length));
      expect(decryptMessage(symKey, nonce, tampered)).toBeNull();
    });
  });

  describe("openSealedSymKey", () => {
    it("opens a key sealed for this device's box keypair, mirroring the gateway's encryptSymKeyForDevices", () => {
      const recipient = nacl.box.keyPair();
      const rawSymKey = nacl.randomBytes(32);
      const ephemeral = nacl.box.keyPair();
      const sealNonce = nacl.randomBytes(nacl.box.nonceLength);
      const sealed = nacl.box(rawSymKey, sealNonce, recipient.publicKey, ephemeral.secretKey);

      const opened = openSealedSymKey(
        {
          ciphertext: bytesToBase64(sealed),
          nonce: bytesToBase64(sealNonce),
          ephemeralPubkey: bytesToBase64(ephemeral.publicKey),
        },
        Buffer.from(recipient.secretKey).toString("hex"),
      );

      expect(opened).toEqual(rawSymKey);
    });

    it("returns null when opened with the wrong device private key", () => {
      const recipient = nacl.box.keyPair();
      const wrongDevice = nacl.box.keyPair();
      const rawSymKey = nacl.randomBytes(32);
      const ephemeral = nacl.box.keyPair();
      const sealNonce = nacl.randomBytes(nacl.box.nonceLength);
      const sealed = nacl.box(rawSymKey, sealNonce, recipient.publicKey, ephemeral.secretKey);

      const opened = openSealedSymKey(
        {
          ciphertext: bytesToBase64(sealed),
          nonce: bytesToBase64(sealNonce),
          ephemeralPubkey: bytesToBase64(ephemeral.publicKey),
        },
        Buffer.from(wrongDevice.secretKey).toString("hex"),
      );

      expect(opened).toBeNull();
    });
  });
});
