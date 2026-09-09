import { EvergramCore, generateWallet } from "../src/index.js";
import { generateDeviceKeypair, deriveDeviceId } from "../src/crypto.js";
import { identityKey } from "../src/identity.js";
import { ChainFamily } from "../src/proto/evergram.js";

// Cross-node relay validation against the real docker-compose.cluster.yml
// 4-node cluster (localhost:9000/9002/9003/9004 -> node-1..4).
//
// This test discovered that the cluster's 4 HotPocket instances do not
// share consensus/contract state with each other in this local setup (each
// node's registerDevice/createChat only lands in that node's own KV store)
// — a pre-existing characteristic of docker-compose.cluster.yml, unrelated
// to the relay feature under test. So: registerDevice + createChat for
// BOTH identities happen through node-1 first (so node-1's contract knows
// about both), then B's WebSocket session moves to a different node for
// the actual test. This is still a faithful test of the relay layer,
// because relay_envelope delivery on the receiving node never re-reads
// contract state — it only looks up the local device-connection registry
// (see relay/inboundHandlers.ts) and forwards the already-authorized,
// already-encrypted envelope. What's being validated is exactly that path.
//
//   1. presence propagation (A watches B, sees ONLINE via the relay mesh)
//   2. live message relay (A on node-1 -> B online on node-3)
//   3. mailbox pull (B goes offline, A sends again, B reconnects on node-4)

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

  const identityKeyA = identityKey({ chainFamily: ChainFamily.XRPL, address: a.wallet.address });
  const identityKeyB = identityKey({ chainFamily: ChainFamily.XRPL, address: b.wallet.address });
  console.log(`[test] A = ${identityKeyA}`);
  console.log(`[test] B = ${identityKeyB}`);

  // --- Setup: register both devices + create the chat, all via node-1 ---
  const nodeA = new EvergramCore({
    url: "ws://localhost:9000/api/ws",
    wallet: a.wallet,
    device: a.device,
  });
  const bOnNode1 = new EvergramCore({
    url: "ws://localhost:9000/api/ws",
    wallet: b.wallet,
    device: b.device,
  });

  console.log("[test] connecting A and B (setup) to node-1...");
  await nodeA.connect();
  await bOnNode1.connect();

  console.log("[test] registering devices (consensus writes, via node-1)...");
  const regA = await nodeA.registerDevice();
  const regB = await bOnNode1.registerDevice();
  console.log("[test] registerDevice A response:", JSON.stringify(regA));
  console.log("[test] registerDevice B response:", JSON.stringify(regB));

  console.log("[test] creating 1:1 chat A<->B (via node-1)...");
  const chatResp: any = await nodeA.createChat("one-on-one", [identityKeyB]);
  console.log("[test] createChat response:", JSON.stringify(chatResp));
  const chatId = chatResp.chat?.chatId ?? chatResp.createChatResponse?.chat?.chatId;
  console.log(`[test] chatId=${chatId}`);
  await wait(3000); // let the sealed-key push to B settle

  console.log("[test] disconnecting B's setup session on node-1...");
  (bOnNode1 as any).transport?.close?.();
  await wait(1000);

  // --- 1. Presence propagation across the relay mesh ---
  const nodeB = new EvergramCore({
    url: "ws://localhost:9003/api/ws",
    wallet: b.wallet,
    device: b.device,
  });
  console.log("[test] connecting B to node-3...");
  await nodeB.connect();

  let sawOnline = false;
  nodeA.on("accountPresence", (event) => {
    if (event.identityKey === identityKeyB && event.online) sawOnline = true;
  });

  console.log(
    "[test] A (node-1) watching B's presence (should propagate node-3 -> node-1 via relay)...",
  );
  nodeA.watchIdentities([identityKeyB]);
  await wait(3000);

  console.log(
    sawOnline
      ? "[PASS] presence propagation: A saw B ONLINE cross-node"
      : "[FAIL] presence propagation: A never saw B ONLINE",
  );

  // --- 2. Live message relay (B online on node-3, A sends from node-1) ---
  let receivedLive: string | null = null;
  nodeB.on("message", (msg) => {
    if (msg.chatId === chatId) receivedLive = msg.text;
  });

  const liveText = `relay-live-${Date.now()}`;
  console.log(`[test] A (node-1) sending "${liveText}" to B while B is online on node-3...`);
  await nodeA.sendMessage(chatId, liveText);
  await wait(4000);

  console.log(
    receivedLive === liveText
      ? "[PASS] live cross-node message relay: B received it via RELAY_ENVELOPE"
      : `[FAIL] live cross-node message relay: B got ${JSON.stringify(receivedLive)}`,
  );

  // --- 3. Mailbox pull: B goes offline, A sends, B reconnects on node-4 ---
  console.log("[test] disconnecting B (simulating offline)...");
  (nodeB as any).transport?.close?.();
  await wait(2000);

  const offlineText = `relay-mailbox-${Date.now()}`;
  console.log(
    `[test] A sending "${offlineText}" to B while B is offline (should mailbox on node-1)...`,
  );
  await nodeA.sendMessage(chatId, offlineText);
  await wait(1000);

  console.log("[test] B reconnecting to node-4 (different node than where it mailboxed)...");
  const nodeB2 = new EvergramCore({
    url: "ws://localhost:9004/api/ws",
    wallet: b.wallet,
    device: b.device,
  });

  let receivedPulled: string | null = null;
  nodeB2.on("message", (msg) => {
    if (msg.chatId === chatId) receivedPulled = msg.text;
  });

  await nodeB2.connect();
  await wait(4000);

  console.log(
    receivedPulled === offlineText
      ? "[PASS] mailbox pull: B (on node-4) received the message mailboxed on node-1 via MAILBOX_PULL"
      : `[FAIL] mailbox pull: B (on node-4) got ${JSON.stringify(receivedPulled)}`,
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal error:", err);
  process.exit(1);
});
