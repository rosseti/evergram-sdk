import { ChainIdentity } from "./proto/evergram.js";

// Mirrors the webapp client's identity-key format exactly — this string
// format is the map key used everywhere server-side (chat participants,
// symKeyEncrypted, profiles), so it must match byte-for-byte.
export function identityKey(identity: ChainIdentity): string {
  return `${identity.chainFamily}:${identity.address}`;
}

export function parseIdentityKey(key: string): ChainIdentity {
  const [chainFamily, address] = key.split(":");
  return { chainFamily: Number(chainFamily), address } as ChainIdentity;
}
