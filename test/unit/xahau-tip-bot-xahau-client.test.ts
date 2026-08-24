import { describe, expect, it } from "vitest";
import {
  exhaustedRetriesError,
  isRetryableSubmitError,
} from "../../examples/xahau-tip-bot/xahau-client.js";

describe("xahau-tip-bot isRetryableSubmitError", () => {
  it("treats a LastLedgerSequence-exceeded error as retryable", () => {
    const err = new Error(
      "The latest ledger sequence 100 is greater than the transaction's LastLedgerSequence (99).",
    );
    expect(isRetryableSubmitError(err)).toBe(true);
  });

  it("does not treat an unrelated error as retryable", () => {
    expect(isRetryableSubmitError(new Error("actNotFound"))).toBe(false);
  });

  it("does not treat a non-Error value as retryable", () => {
    expect(isRetryableSubmitError("LastLedgerSequence")).toBe(false);
    expect(isRetryableSubmitError(undefined)).toBe(false);
  });
});

describe("xahau-tip-bot exhaustedRetriesError", () => {
  it("mentions Hooks, the attempted fee, and the cap", () => {
    const err = exhaustedRetriesError(8000, 50000, new Error("original message"));
    expect(err.message).toMatch(/Hooks-enabled/);
    expect(err.message).toContain("8000");
    expect(err.message).toContain("50000");
    expect(err.message).toContain("original message");
  });

  it("stringifies a non-Error cause", () => {
    const err = exhaustedRetriesError(20, 1000, "plain string cause");
    expect(err.message).toContain("plain string cause");
  });
});
