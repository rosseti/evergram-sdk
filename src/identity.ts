import { ChainIdentity } from "./proto/evergram";

// Mirrors webapp/app/lib/identity.ts exactly — this string format is the
// map key the gateway/contract use everywhere (chat participants,
// symKeyEncrypted, profiles), so it must match byte-for-byte.
export function identityKey(identity: ChainIdentity): string {
  return `${identity.chainFamily}:${identity.address}`;
}

export function parseIdentityKey(key: string): ChainIdentity {
  const [chainFamily, address] = key.split(":");
  return { chainFamily: Number(chainFamily), address } as ChainIdentity;
}
