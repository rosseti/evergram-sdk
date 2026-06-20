import { afterEach, describe, expect, it } from "vitest";
import { EvergramCore } from "../../src/core";
import { openRawConnection, RawClient } from "./_raw-client";
import { buildAuthMessage, freshIdentity, WS_URL } from "./_helpers";

// Requires the local stack up (docker-compose.yml or an equivalent gateway)
// reachable at WS_URL — see sdk/README.md's "Testing" section. This suite
// codifies exactly what the nonce-based auth hardening was built to
// guarantee: a signature is only ever valid for the one connection and the
// one challenge it was issued for.

const openClients: (RawClient | EvergramCore)[] = [];

afterEach(() => {
  while (openClients.length) {
    openClients.pop()!.close();
  }
});

async function connectRaw() {
  const client = await openRawConnection(WS_URL);
  openClients.push(client);
  return client;
}

function trackCore(core: EvergramCore) {
  openClients.push(core);
  return core;
}

describe("signed_message auth — nonce-based challenge", () => {
  it("a fresh wallet self-heals via registerDevice and authenticates", async () => {
    const { wallet, device } = freshIdentity();
    const core = trackCore(new EvergramCore({ url: WS_URL, wallet, device }));
    await core.connect();
  });

  it("rejects a signature captured on one connection when replayed on another", async () => {
    const { wallet, device } = freshIdentity();

    const a = await connectRaw();
    const challengeA = await a.waitFor("authChallenge");
    const authMsg = buildAuthMessage(wallet, device, challengeA.nonce);

    const b = await connectRaw();
    await b.waitFor("authChallenge"); // B has its own, different nonce

    b.send(authMsg); // signature bound to A's nonce, replayed on B
    const err = await b.waitFor("error");
    expect(err.message).toBe("invalid_signed_message_signature");
  });

  it("rejects a second auth attempt on the same connection once its nonce is consumed", async () => {
    const { wallet, device } = freshIdentity();

    const conn = await connectRaw();
    const challenge = await conn.waitFor("authChallenge");

    // Tamper with an otherwise-valid proof so this connection's first auth
    // attempt fails (not succeeds) — a successful auth flips
    // ws.__sessionAccepted, which short-circuits nonce validation entirely
    // and would make a "second attempt" meaningless to test.
    const authMsg = buildAuthMessage(wallet, device, challenge.nonce);
    const proof = authMsg.auth!.proof!.signedMessage!;
    proof.signatureHex = proof.signatureHex.slice(0, -2) + (proof.signatureHex.endsWith("00") ? "11" : "00");

    conn.send(authMsg);
    const err1 = await conn.waitFor("error");
    expect(err1.message).toBe("invalid_signed_message_signature");

    conn.send(authMsg); // nonce was already consumed by the failed first attempt
    const err2 = await conn.waitFor("error");
    expect(err2.message).toBe("no_active_auth_challenge");
  });
});
