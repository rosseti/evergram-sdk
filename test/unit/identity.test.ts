import { describe, expect, it } from "vitest";
import { identityKey, parseIdentityKey } from "../../src/identity";
import { ChainFamily } from "../../src/proto/evergram";

describe("identity", () => {
  it("identityKey formats as chainFamily:address, matching webapp/app/lib/identity.ts", () => {
    expect(identityKey({ chainFamily: ChainFamily.XRPL, address: "rSomeAddress" } as any)).toBe(
      "1:rSomeAddress"
    );
  });

  it("parseIdentityKey is the exact inverse of identityKey", () => {
    const original = { chainFamily: ChainFamily.XRPL, address: "rSomeAddress" };
    const parsed = parseIdentityKey(identityKey(original as any));
    expect(parsed.chainFamily).toBe(original.chainFamily);
    expect(parsed.address).toBe(original.address);
  });
});
