import { deriveAddress } from "xrpl";
import { deriveKeypair, generateSeed, sign } from "ripple-keypairs";

export interface EvergramWallet {
  seed: string;
  address: string;
  publicKeyHex: string;
  privateKeyHex: string;
}

export function generateWallet(): EvergramWallet {
  const seed = generateSeed();
  return walletFromSeed(seed);
}

export function walletFromSeed(seed: string): EvergramWallet {
  const kp = deriveKeypair(seed);
  return {
    seed,
    address: deriveAddress(kp.publicKey),
    publicKeyHex: kp.publicKey,
    privateKeyHex: kp.privateKey,
  };
}

// Must match webapp/app/gateway/helpers/verify-signed-message.ts's
// buildAuthChallenge() exactly — same string, same minute-bucketed
// timestamp — or every signature this produces will be rejected as
// invalid_signed_message_signature.
export function buildAuthChallenge(address: string, deviceId: string, unixMinuteTimestamp: number): string {
  return `evergram-auth:${address}:${deviceId}:${unixMinuteTimestamp}`;
}

// Signs the current-minute auth challenge for this wallet/device pair,
// ready to drop into AuthProof.signedMessage. The gateway accepts a small
// tolerance window around "now" (see verify-signed-message.ts) to absorb
// clock drift, so signing the current minute is always correct.
export function signAuthChallenge(wallet: EvergramWallet, deviceId: string): { publicKeyHex: string; signatureHex: string } {
  const unixMinuteTimestamp = Math.floor(Date.now() / 60_000);
  const challenge = buildAuthChallenge(wallet.address, deviceId, unixMinuteTimestamp);
  const challengeHex = Buffer.from(challenge, "utf8").toString("hex");

  return {
    publicKeyHex: wallet.publicKeyHex,
    signatureHex: sign(challengeHex, wallet.privateKeyHex),
  };
}
