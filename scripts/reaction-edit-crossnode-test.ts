import { EvergramCore, generateWallet } from "../src/index.js";
import { generateDeviceKeypair, deriveDeviceId } from "../src/crypto.js";
import { identityKey } from "../src/identity.js";
import { ChainFamily } from "../src/proto/evergram.js";

// Reproduces the user's report: reactions/edit/delete not propagating
// cross-node. A on node-1, B on node-3, both online for the whole test.

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
  console.log(`[test] A = ${identityKeyA} (node-1)`);
  console.log(`[test] B = ${identityKeyB} (node-3)`);

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
  await nodeB.connect();
  await nodeA.registerDevice();
  await nodeB.registerDevice();

  const chatResp: any = await nodeA.createChat("one-on-one", [identityKeyA, identityKeyB]);
  const chatId = chatResp.chat?.chatId ?? chatResp.createChatResponse?.chat?.chatId;
  console.log(`[test] chatId=${chatId}`);
  await wait(3000);

  // Seed a message from A so B has something to react to / that A can edit.
  let seenMsgId: string | null = null;
  nodeB.on("message", (msg) => {
    if (msg.chatId === chatId) seenMsgId = msg.msgId;
  });

  await nodeA.sendMessage(chatId, "hello cross-node");
  await wait(3000);

  (nodeA as any).transport.onMessage((msg: any) => {
    if (msg.envelope?.react || msg.envelope?.edit) {
      console.log("[test] raw envelope on A:", JSON.stringify(msg.envelope));
    }
  });
  (nodeB as any).transport.onMessage((msg: any) => {
    if (msg.envelope?.react || msg.envelope?.edit) {
      console.log("[test] raw envelope on B:", JSON.stringify(msg.envelope));
    }
  });

  if (!seenMsgId) {
    console.log("[FAIL] B never received the seed message — can't test reaction/edit");
    process.exit(1);
  }
  console.log(`[test] seed message delivered, msgId=${seenMsgId}`);

  // --- Reaction: B reacts to A's message, A should see it live ---
  let sawReaction = false;
  nodeA.on("reaction", (r) => {
    if (r.msgId === seenMsgId) sawReaction = true;
  });

  console.log("[test] B reacting to A's message...");
  await nodeB.reactToMessage(chatId, seenMsgId!, "👍");
  await wait(3000);
  console.log(
    sawReaction ? "[PASS] reaction propagated cross-node" : "[FAIL] reaction never reached A",
  );

  // --- Edit: A edits their own message, B should see it live ---
  let sawEdit = false;
  nodeB.on("messageEdited", (e) => {
    if (e.msgId === seenMsgId) sawEdit = true;
  });

  console.log("[test] A editing their message...");
  await nodeA.editMessage(chatId, seenMsgId!, "hello cross-node (edited)");
  await wait(3000);
  console.log(sawEdit ? "[PASS] edit propagated cross-node" : "[FAIL] edit never reached B");

  // --- Delete: A deletes their message, B should see it live ---
  let sawDelete = false;
  nodeB.on("messageDeleted", (d) => {
    if (d.msgId === seenMsgId) sawDelete = true;
  });

  console.log("[test] A deleting their message...");
  await nodeA.deleteMessage(chatId, seenMsgId!);
  await wait(3000);
  console.log(sawDelete ? "[PASS] delete propagated cross-node" : "[FAIL] delete never reached B");

  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal error:", err);
  process.exit(1);
});
