import { describe, expect, it } from "vitest";
import { verifyKeypairSignature } from "xrpl";
import {
  buildAuthChallenge,
  generateWallet,
  signAuthChallenge,
  walletFromSeed,
} from "../../src/wallet.js";

// Exercises the exact crypto the gateway's verify-signed-message.ts depends
// on (xrpl's verifyKeypairSignature), without needing the gateway running —
// catches regressions in buildAuthChallenge's string format or
// signAuthChallenge's hex encoding before they ever reach a real connection.

describe("wallet", () => {
  it("generateWallet produces a valid XRPL address and matching keypair", () => {
    const wallet = generateWallet();
    expect(wallet.address).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
    expect(wallet.publicKeyHex).toMatch(/^[0-9a-fA-F]+$/);
    expect(wallet.privateKeyHex).toMatch(/^[0-9a-fA-F]+$/);
  });

  it("walletFromSeed is deterministic", () => {
    const a = generateWallet();
    const b = walletFromSeed(a.seed);
    expect(b.address).toBe(a.address);
    expect(b.publicKeyHex).toBe(a.publicKeyHex);
  });

  it("buildAuthChallenge matches the gateway's exact string format", () => {
    const challenge = buildAuthChallenge("rTestAddress", "device123", "nonceABC");
    expect(challenge).toBe("evergram-auth:rTestAddress:device123:nonceABC");
  });

  it("signAuthChallenge produces a signature that verifies against the wallet's public key", () => {
    const wallet = generateWallet();
    const proof = signAuthChallenge(wallet, "device123", "nonce-xyz");

    expect(proof.publicKeyHex).toBe(wallet.publicKeyHex);

    const challengeHex = Buffer.from(
      buildAuthChallenge(wallet.address, "device123", "nonce-xyz"),
      "utf8",
    ).toString("hex");

    expect(verifyKeypairSignature(challengeHex, proof.signatureHex, proof.publicKeyHex)).toBe(true);
  });

  it("a signature bound to one nonce fails verification against a different nonce", () => {
    const wallet = generateWallet();
    const proof = signAuthChallenge(wallet, "device123", "nonce-one");

    const otherChallengeHex = Buffer.from(
      buildAuthChallenge(wallet.address, "device123", "nonce-two"),
      "utf8",
    ).toString("hex");

    expect(verifyKeypairSignature(otherChallengeHex, proof.signatureHex, proof.publicKeyHex)).toBe(
      false,
    );
  });

  it("a signature bound to one device fails verification against a different deviceId", () => {
    const wallet = generateWallet();
    const proof = signAuthChallenge(wallet, "device-a", "nonce-xyz");

    const otherChallengeHex = Buffer.from(
      buildAuthChallenge(wallet.address, "device-b", "nonce-xyz"),
      "utf8",
    ).toString("hex");

    expect(verifyKeypairSignature(otherChallengeHex, proof.signatureHex, proof.publicKeyHex)).toBe(
      false,
    );
  });
});
