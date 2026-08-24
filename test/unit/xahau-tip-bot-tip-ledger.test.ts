import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadProcessedTips,
  recordProcessedTip,
  type ProcessedTip,
} from "../../examples/xahau-tip-bot/tip-ledger.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xahau-tip-bot-ledger-"));
  path = join(dir, "tip-ledger.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tip(msgId: string): ProcessedTip {
  return {
    msgId,
    txHash: `hash-${msgId}`,
    amount: "1",
    currency: "XAH",
    toAddress: "rDest",
    ts: 0,
  };
}

describe("xahau-tip-bot tip-ledger", () => {
  it("loadProcessedTips returns an empty map when the file doesn't exist yet", () => {
    expect(loadProcessedTips(path).size).toBe(0);
  });

  it("recordProcessedTip persists across a fresh load", () => {
    const processed = loadProcessedTips(path);
    recordProcessedTip(path, processed, tip("msg-1"));

    const reloaded = loadProcessedTips(path);
    expect(reloaded.get("msg-1")?.txHash).toBe("hash-msg-1");
  });

  it("recordProcessedTip updates the in-memory map immediately, without a reload", () => {
    const processed = loadProcessedTips(path);
    recordProcessedTip(path, processed, tip("msg-1"));

    expect(processed.get("msg-1")?.txHash).toBe("hash-msg-1");
  });
});
