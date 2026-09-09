import { EvergramCore, generateWallet } from "../src/index.js";
import { generateDeviceKeypair, deriveDeviceId } from "../src/crypto.js";

// Validates the new getNetworkStats() (IRC LUSERS-style): A connects to
// node-1, B connects to node-3 — A's view of the cluster should count both
// (localUsers=1 on node-1, globalUsers=2 across the mesh, peerNodes=3).

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeIdentity() {
  const wallet = generateWallet();
  const { pubHex, privHex } = generateDeviceKeypair();
  const device = { deviceId: deriveDeviceId(pubHex), devicePubHex: pubHex, devicePrivHex: privHex };
  return { wallet, device };
}

async function main() {
  const a = makeIdentity();
  const b = makeIdentity();

  const nodeA = new EvergramCore({
    url: "ws://localhost:9000/api/ws",
    wallet: a.wallet,
    device: a.device,
  });
  const nodeB = new EvergramCore({
    url: "ws://localhost:9003/api/ws",
    wallet: b.wallet,
    device: b.device,
  });

  await nodeA.connect();
  await nodeA.registerDevice();

  const statsBefore = await nodeA.getNetworkStats();
  console.log("[test] stats from node-1 with only A connected:", JSON.stringify(statsBefore));

  console.log("[test] connecting B to node-3...");
  await nodeB.connect();
  await nodeB.registerDevice();
  await wait(2000); // let presence propagate

  const statsAfter = await nodeA.getNetworkStats();
  console.log("[test] stats from node-1 with A+B connected:", JSON.stringify(statsAfter));

  const ok =
    statsBefore.localUsers === 1 &&
    statsBefore.globalUsers === 1 &&
    statsAfter.localUsers === 1 &&
    statsAfter.globalUsers === 2 &&
    statsAfter.peerNodes === 3;

  console.log(
    ok
      ? "[PASS] getNetworkStats reflects local vs global correctly"
      : "[FAIL] unexpected stats values",
  );

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[test] fatal error:", err);
  process.exit(1);
});
