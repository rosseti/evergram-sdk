import { afterEach, describe, it } from "vitest";
import { EvergramCore } from "../../src/core.js";
import { freshIdentity, WS_URL } from "./_helpers.js";

// Requires the local stack up — see sdk/README.md's "Testing" section.
// Both cases here matter specifically because of the nonce redesign: every
// physical connection — whether opened by Transport's own backoff-driven
// reconnect or forced open again by requestWithReauth — must receive and
// use a brand-new nonce, since the gateway only ever pushes one per
// connection and never re-validates a connection it already accepted.

const openCores: EvergramCore[] = [];

afterEach(() => {
  while (openCores.length) openCores.pop()!.close();
});

async function connectFreshBot() {
  const identity = freshIdentity();
  const core = new EvergramCore({ url: WS_URL, ...identity });
  openCores.push(core);
  await core.connect();
  return core;
}

describe("reconnection and session recovery", () => {
  it("automatically reconnects and re-authenticates after a forced disconnect", async () => {
    const core = await connectFreshBot();

    const reauthenticated = new Promise<void>((resolve) => core.once("authenticated", resolve));
    const disconnected = new Promise<void>((resolve) => core.once("disconnected", resolve));

    // Simulates a dropped connection (network blip, gateway restart) rather
    // than a clean client-initiated close — exercises Transport's own
    // reconnect-with-backoff path, not requestWithReauth's.
    (core as any).transport.ws.terminate();

    await disconnected;
    await reauthenticated;
  });

  it("requestWithReauth recovers via a fresh connection instead of hanging on a stale nonce wait", async () => {
    const core = await connectFreshBot();

    // Mirrors exactly what requestWithReauth does internally when a live
    // request comes back with an EvergramAuthError (e.g. a 24h-stale
    // session JWT on a connection that never dropped) — see core.ts's
    // reconnectAndAuthenticate(). Calling authenticate() directly on an
    // already-open connection would hang for a nonce that's never coming;
    // this proves the fix actually re-establishes a working session.
    await (core as any).reconnectAndAuthenticate();

    await core.setProfile({ nickname: "reauth-smoke-test" });
  });
});
