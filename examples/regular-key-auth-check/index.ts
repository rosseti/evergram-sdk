// One-off manual check for RegularKey auth against a real gateway: fill in
// your own account address + RegularKey seed below (or via env vars), point
// EVERGRAM_GATEWAY_URL at your running gateway, and run it. It just
// connects and reports whether auth succeeded — no chat/bot logic.
//
//   ACCOUNT_ADDRESS=r...       npm run example:regular-key-auth-check
//   REGULAR_KEY_SEED=sEd...
//   EVERGRAM_GATEWAY_URL=ws://localhost:9000/api/ws   (defaults to this)
//
// Prerequisites on the account itself (see the SDK README's RegularKey
// note): ACCOUNT_ADDRESS must exist on-ledger and have a SetRegularKey
// transaction pointing at the account whose seed you pass as
// REGULAR_KEY_SEED. Revoke/rotate the RegularKey between runs to exercise
// the gateway's revocation check (see webapp's account-ledger-info.ts).
import {
  EvergramCore,
  generateDeviceKeypair,
  deriveDeviceId,
  walletFromRegularKey,
} from "../../src/index.js";

const GATEWAY_URL = process.env.EVERGRAM_GATEWAY_URL || "ws://localhost:9000/api/ws";
const ACCOUNT_ADDRESS = process.env.ACCOUNT_ADDRESS || "PUT_YOUR_ACCOUNT_ADDRESS_HERE";
const REGULAR_KEY_SEED = process.env.REGULAR_KEY_SEED || "PUT_YOUR_REGULAR_KEY_SEED_HERE";

async function main() {
  if (ACCOUNT_ADDRESS.startsWith("PUT_YOUR_") || REGULAR_KEY_SEED.startsWith("PUT_YOUR_")) {
    console.error(
      "[regular-key-auth-check] Set ACCOUNT_ADDRESS and REGULAR_KEY_SEED (env vars or edit this file) before running.",
    );
    process.exit(1);
  }

  const wallet = walletFromRegularKey(ACCOUNT_ADDRESS, REGULAR_KEY_SEED);

  // Ephemeral device: this is a one-off connectivity check, not a bot you
  // want history synced onto, so there's no point persisting it like
  // load-identity.ts does for the other examples.
  const { pubHex, privHex } = generateDeviceKeypair();
  const device = { deviceId: deriveDeviceId(pubHex), devicePubHex: pubHex, devicePrivHex: privHex };

  console.log(`[regular-key-auth-check] account:     ${wallet.address}`);
  console.log(`[regular-key-auth-check] signing key: ${wallet.publicKeyHex} (RegularKey)`);
  console.log(`[regular-key-auth-check] gateway:     ${GATEWAY_URL}`);

  const core = new EvergramCore({ url: GATEWAY_URL, wallet, device });

  core.on("authenticated", () => {
    console.log("[regular-key-auth-check] AUTH OK — gateway accepted the RegularKey signature.");
    process.exit(0);
  });

  core.on("error", (err) => {
    console.error(
      "[regular-key-auth-check] AUTH FAILED:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });

  try {
    await core.connect();
  } catch (err) {
    console.error(
      "[regular-key-auth-check] AUTH FAILED (connect rejected):",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[regular-key-auth-check] fatal:", err);
  process.exit(1);
});
