import { describe, expect, it } from "vitest";
import { parseTipCommand } from "../../examples/xahau-tip-bot/commands.js";

const VALID_ADDRESS = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"; // well-known example XRPL address

describe("xahau-tip-bot parseTipCommand", () => {
  it("falls back to replySender when no target token is given", () => {
    const result = parseTipCommand("!tip 5 XAH", "1:rReplySender");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tip).toEqual({
      amount: "5",
      currency: "XAH",
      target: { kind: "reply", identityKey: "1:rReplySender" },
    });
  });

  it("defaults currency to XAH when omitted", () => {
    const result = parseTipCommand("!tip 5", "1:rReplySender");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tip.currency).toBe("XAH");
  });

  it("errors when there's no target token and no replySender", () => {
    const result = parseTipCommand("!tip 5", null);
    expect(result.ok).toBe(false);
  });

  it("parses an explicit @identityKey mention", () => {
    const result = parseTipCommand("!tip @1:rMentioned 2.5 XAH", null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tip).toEqual({
      amount: "2.5",
      currency: "XAH",
      target: { kind: "mention", identityKey: "1:rMentioned" },
    });
  });

  it("parses a raw classic address", () => {
    const result = parseTipCommand(`!tip ${VALID_ADDRESS} 10`, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tip.target).toEqual({ kind: "address", address: VALID_ADDRESS });
  });

  it("rejects a non-positive amount", () => {
    const result = parseTipCommand("!tip 0 XAH", "1:rReplySender");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-numeric amount", () => {
    const result = parseTipCommand("!tip banana XAH", "1:rReplySender");
    expect(result.ok).toBe(false);
  });

  it("rejects an amount finer than XAH's 6-decimal drop precision", () => {
    const result = parseTipCommand("!tip 0.00000012 XAH", "1:rReplySender");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/decimal places/);
  });

  it("accepts an amount at exactly 6 decimal places", () => {
    const result = parseTipCommand("!tip 0.000001 XAH", "1:rReplySender");
    expect(result.ok).toBe(true);
  });

  it("rejects a mention with a missing amount", () => {
    const result = parseTipCommand("!tip @1:rMentioned", null);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty command", () => {
    const result = parseTipCommand("!tip", null);
    expect(result.ok).toBe(false);
  });
});
