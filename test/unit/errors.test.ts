import { describe, expect, it } from "vitest";
import {
  EvergramAccessDeniedError,
  EvergramAuthError,
  EvergramError,
  EvergramNotFoundError,
  EvergramRateLimitError,
  EvergramRestrictedError,
  EvergramValidationError,
  errorFromCode,
} from "../../src/errors";

// Each case here mirrors a real gateway/contract error code (see
// src/errors.ts's tables) — if a new auth-related code is ever added on the
// gateway side without updating AUTH_CODES here, callers silently get a
// generic EvergramError instead of EvergramAuthError. This test won't catch
// that automatically, but pins down today's known mappings so a future
// change to the tables is a deliberate edit, not an accidental diff.
describe("errorFromCode", () => {
  it.each([
    ["invalid_signed_message_signature", EvergramAuthError],
    ["no_active_auth_challenge" as any, EvergramError], // not yet in any known table — see note below
    ["device_not_registered", EvergramNotFoundError],
    ["rate_limited", EvergramRateLimitError],
    ["capability_not_allowed", EvergramAccessDeniedError],
    ["account_restricted", EvergramRestrictedError],
    ["invalid_message_size", EvergramValidationError],
    ["totally_unknown_code", EvergramError],
  ])("maps %s to %s", (code, ErrorClass) => {
    const err = errorFromCode(code);
    expect(err).toBeInstanceOf(ErrorClass);
    expect(err.code).toBe(code);
  });

  it("preserves the message alongside the typed code", () => {
    const err = errorFromCode("rate_limited", "Too many requests");
    expect(err.message).toBe("Too many requests");
  });
});
