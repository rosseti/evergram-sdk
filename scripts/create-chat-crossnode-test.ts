import { EvergramCore, generateWallet } from "../src/index.js";
import { generateDeviceKeypair, deriveDeviceId } from "../src/crypto.js";
import { identityKey } from "../src/identity.js";
import { ChainFamily } from "../src/proto/evergram.js";

// Reproduces the user's manual bug report: identity A creates a chat with
// identity B while A is connected to node-4 and B is already connected
// (idle, watching) on a DIFFERENT node. Before the deliverToIdentity fix,
// createChatResponse.ts only pushed the new-chat notification to B's
// LOCAL device map on whichever node handled the createChat request — if B
// wasn't connected there, B got nothing live, only picking it up on a
// later resync/reload. This checks B receives "chatSynced" live, with no
// reload, when A and B are on different nodes.

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
  console.log(`[test] A = ${identityKeyA} (will connect to node-4)`);
  console.log(`[test] B = ${identityKeyB} (will connect to node-2, stay idle)`);

  const nodeA = new EvergramCore({
    url: "ws://localhost:9004/api/ws",
    wallet: a.wallet,
    device: a.device,
  });
  const nodeB = new EvergramCore({
    url: "ws://localhost:9002/api/ws",
    wallet: b.wallet,
    device: b.device,
  });

  console.log("[test] connecting A (node-4) and B (node-2)...");
  await nodeA.connect();
  await nodeB.connect();

  console.log("[test] registering devices...");
  await nodeA.registerDevice();
  await nodeB.registerDevice();

  let sawChatSyncedLive = false;
  let sawChatId: string | null = null;
  nodeB.on("chatSynced", (chat) => {
    sawChatSyncedLive = true;
    sawChatId = chat.chatId;
  });

  (nodeA as any).transport.onMessage((msg: any) => {
    if (msg.createChatResponse) {
      console.log("[test] raw createChatResponse:", JSON.stringify(msg.createChatResponse));
    }
  });

  console.log(
    "[test] A (node-4) creating 1:1 chat with B (idle on node-2), no reload/resync triggered on B...",
  );
  const chatResp: any = await nodeA.createChat("one-on-one", [identityKeyA, identityKeyB]);
  const chatId = chatResp.chat?.chatId ?? chatResp.createChatResponse?.chat?.chatId;
  console.log(`[test] chatId=${chatId}`);

  await wait(4000);

  console.log(
    sawChatSyncedLive && sawChatId === chatId
      ? "[PASS] B (node-2) received the new chat live via relay, no reload needed"
      : `[FAIL] B never got a live chatSynced for ${chatId} (sawChatSyncedLive=${sawChatSyncedLive}, sawChatId=${sawChatId})`,
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal error:", err);
  process.exit(1);
});
