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

// For accounts signing with a regular key instead of their master secret:
// `accountAddress` is the account being authenticated as, `regularKeySeed`
// is the seed of the key set as that account's RegularKey on-ledger. The
// gateway verifies the resulting signature against publicKeyHex and then
// checks that key is authorized for `address` (master or regular) — same
// flow as master-key wallets, just with the two no longer tied to the same
// keypair.
export function walletFromRegularKey(
  accountAddress: string,
  regularKeySeed: string,
): EvergramWallet {
  const kp = deriveKeypair(regularKeySeed);
  return {
    seed: regularKeySeed,
    address: accountAddress,
    publicKeyHex: kp.publicKey,
    privateKeyHex: kp.privateKey,
  };
}

// Must match the gateway's own buildAuthChallenge() exactly — same string —
// or every signature this produces will be rejected as
// invalid_signed_message_signature.
export function buildAuthChallenge(address: string, deviceId: string, nonce: string): string {
  return `evergram-auth:${address}:${deviceId}:${nonce}`;
}

// Signs this connection's auth challenge for this wallet/device pair, ready
// to drop into AuthProof.signedMessage. `nonce` comes from the gateway's
// AuthChallenge push (see EvergramCore.authenticate()) — it's single-use and
// scoped to one connection, so this must be called fresh after every
// connect/reconnect, never cached.
export function signAuthChallenge(
  wallet: EvergramWallet,
  deviceId: string,
  nonce: string,
): { publicKeyHex: string; signatureHex: string } {
  const challenge = buildAuthChallenge(wallet.address, deviceId, nonce);
  const challengeHex = Buffer.from(challenge, "utf8").toString("hex");

  return {
    publicKeyHex: wallet.publicKeyHex,
    signatureHex: sign(challengeHex, wallet.privateKeyHex),
  };
}
