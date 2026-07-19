import { describe, expect, it } from "vitest";
import { buildAudioMessage, buildPaymentReceipt, buildPaymentRequest } from "../../src/message-builders.js";
import { parseMessageContent } from "../../src/message-content.js";

describe("message-builders", () => {
  it("buildPaymentRequest round-trips through parseMessageContent, discriminated by `type` not `__ev`", () => {
    const wire = buildPaymentRequest({
      amount: "10.5",
      currency: "XAH",
      currencyId: "XAH",
      to: "rDestination",
      toIdentityKey: "1:rDestination",
    });

    expect(JSON.parse(wire).__ev).toBeUndefined();
    expect(JSON.parse(wire).type).toBe("payment_request");

    const content = parseMessageContent(wire);
    expect(content.type).toBe("payment_request");
    if (content.type !== "payment_request") throw new Error("unreachable");
    expect(content.amount).toBe("10.5");
    expect(content.to).toBe("rDestination");
    expect(typeof content.requestId).toBe("string");
  });

  it("buildPaymentRequest accepts a caller-supplied requestId instead of generating one", () => {
    const wire = buildPaymentRequest({
      requestId: "fixed-id",
      amount: "1",
      currency: "XAH",
      currencyId: "XAH",
      to: "rDestination",
      toIdentityKey: "1:rDestination",
    });

    const content = parseMessageContent(wire);
    if (content.type !== "payment_request") throw new Error("unreachable");
    expect(content.requestId).toBe("fixed-id");
  });

  it("buildPaymentReceipt round-trips through parseMessageContent", () => {
    const wire = buildPaymentReceipt({
      requestId: "fixed-id",
      txHash: "ABCDEF",
      amount: "1",
      currency: "XAH",
      currencyId: "XAH",
      from: "rPayer",
      fromIdentityKey: "1:rPayer",
    });

    const content = parseMessageContent(wire);
    expect(content.type).toBe("payment_receipt");
    if (content.type !== "payment_receipt") throw new Error("unreachable");
    expect(content.txHash).toBe("ABCDEF");
  });

  it("buildAudioMessage round-trips through parseMessageContent, with wire type matching AudioContent.type", () => {
    const audioBytes = new Uint8Array([1, 2, 3, 4]);
    const wire = buildAudioMessage({ audioBytes, mimeType: "audio/webm", durationMs: 1234 });

    expect(JSON.parse(wire).type).toBe("audio");

    const content = parseMessageContent(wire);
    expect(content.type).toBe("audio");
    if (content.type !== "audio") throw new Error("unreachable");
    expect(content.mimeType).toBe("audio/webm");
    expect(content.durationMs).toBe(1234);
    expect(content.size).toBe(4);
  });
});
