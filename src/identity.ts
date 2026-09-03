import { ChainFamily, ChainIdentity } from "./proto/evergram.js";
import { EvergramValidationError } from "./errors.js";

// Mirrors the webapp client's identity-key format exactly — this string
// format is the map key used everywhere server-side (chat participants,
// symKeyEncrypted, profiles), so it must match byte-for-byte.
export function identityKey(identity: ChainIdentity): string {
  return `${identity.chainFamily}:${identity.address}`;
}

// CHAIN_FAMILY_UNSPECIFIED (0) and UNRECOGNIZED (-1) are enum members, not
// real chains — a genuine identity key never carries either.
const VALID_CHAIN_FAMILIES = new Set<number>([
  ChainFamily.XRPL,
  ChainFamily.EVM,
  ChainFamily.BTC,
  ChainFamily.SOL,
]);

export function parseIdentityKey(key: string): ChainIdentity {
  // Split on the FIRST colon only — identityKey() above never produces more
  // than one, but an address format could in principle contain one itself;
  // naive `.split(":")` destructuring would silently truncate that.
  const sep = key.indexOf(":");
  const chainFamily = sep === -1 ? Number.NaN : Number(key.slice(0, sep));
  const address = sep === -1 ? "" : key.slice(sep + 1);

  // Without this, a malformed key (missing separator, non-numeric prefix,
  // empty address) silently becomes { chainFamily: NaN, address: "" } —
  // garbage that still type-checks as ChainIdentity and goes out on the
  // wire as-is (e.g. via getProfile), same failure shape hexToBytes already
  // guards against for hex strings.
  if (!Number.isInteger(chainFamily) || !VALID_CHAIN_FAMILIES.has(chainFamily) || !address) {
    throw new EvergramValidationError("invalid_identity_key", `Not a valid identity key: ${key}`);
  }

  return { chainFamily, address };
}
