import { describe, expect, it, vi } from "vitest";
import { EvergramCore, EvergramDevice } from "../../src/core.js";
import { deriveDeviceId, generateDeviceKeypair } from "../../src/crypto.js";
import { generateWallet } from "../../src/wallet.js";
import { ChatSyncResult_Status, ServerMessage } from "../../src/proto/evergram.js";

// Regression coverage for a gap found while auditing the chatVersion/
// metaVersion split: handlePush() built chatCandidates from queryChatsResponse
// results but never looked at result.status, so a MISSING result (server no
// longer has this chat) silently did nothing — the chat stayed in the
// private `chats` Map forever, and syncChats() kept re-sending its version
// on every subsequent sync for no reason.

vi.mock("../../src/transport", () => {
  class FakeTransport {
    onMessage() {
      return () => {};
    }
    onOpen() {
      return () => {};
    }
    onClose() {
      return () => {};
    }
    onReconnecting() {
      return () => {};
    }
    isOpen() {
      return false;
    }
    connect() {
      return Promise.resolve();
    }
    close() {}
    send() {}
  }
  return { Transport: FakeTransport };
});

function makeCore(): EvergramCore {
  const wallet = generateWallet();
  const { pubHex, privHex } = generateDeviceKeypair();
  const device: EvergramDevice = {
    deviceId: deriveDeviceId(pubHex),
    devicePubHex: pubHex,
    devicePrivHex: privHex,
  };
  return new EvergramCore({ url: "ws://localhost:9000/api/ws", wallet, device });
}

describe("handlePush: MISSING chat pruning", () => {
  it("removes a chat from the local map and emits chatRemoved on a MISSING queryChatsResponse result", () => {
    const core = makeCore();
    const chatId = "chat-gone";

    // Seed local state as if a prior sync had this chat.
    (core as any).chats.set(chatId, { chatId, chatVersion: 1, metaVersion: 1, participants: [] });
    expect(core.getChat(chatId)).toBeDefined();

    const removedHandler = vi.fn();
    core.on("chatRemoved", removedHandler);

    const msg: ServerMessage = {
      queryChatsResponse: {
        status: { ok: true },
        account: "",
        results: [{ chatId, status: ChatSyncResult_Status.MISSING }],
        pendingChatRequests: [],
        pendingGroupInvites: [],
      },
    } as unknown as ServerMessage;

    (core as any).handlePush(msg);

    expect(core.getChat(chatId)).toBeUndefined();
    expect(removedHandler).toHaveBeenCalledWith(chatId);
  });

  it("does not emit chatRemoved for a chat it never had (delete() returns false)", () => {
    const core = makeCore();
    const removedHandler = vi.fn();
    core.on("chatRemoved", removedHandler);

    const msg: ServerMessage = {
      queryChatsResponse: {
        status: { ok: true },
        account: "",
        results: [{ chatId: "never-seen", status: ChatSyncResult_Status.MISSING }],
        pendingChatRequests: [],
        pendingGroupInvites: [],
      },
    } as unknown as ServerMessage;

    (core as any).handlePush(msg);

    expect(removedHandler).not.toHaveBeenCalled();
  });

  it("leaves UP_TO_DATE/OUTDATED results untouched (no pruning, chat stays or updates normally)", () => {
    const core = makeCore();
    const chatId = "chat-still-here";
    (core as any).chats.set(chatId, { chatId, chatVersion: 1, metaVersion: 1, participants: [] });

    const removedHandler = vi.fn();
    core.on("chatRemoved", removedHandler);

    const msg: ServerMessage = {
      queryChatsResponse: {
        status: { ok: true },
        account: "",
        results: [{ chatId, status: ChatSyncResult_Status.UP_TO_DATE }],
        pendingChatRequests: [],
        pendingGroupInvites: [],
      },
    } as unknown as ServerMessage;

    (core as any).handlePush(msg);

    expect(core.getChat(chatId)).toBeDefined();
    expect(removedHandler).not.toHaveBeenCalled();
  });
});
