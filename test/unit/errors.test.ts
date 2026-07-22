import { describe, expect, it } from "vitest";
import {
  EvergramAccessDeniedError,
  EvergramAuthError,
  EvergramDeviceRevokedError,
  EvergramError,
  EvergramNotFoundError,
  EvergramRateLimitError,
  EvergramRestrictedError,
  EvergramRotationError,
  EvergramValidationError,
  errorFromCode,
} from "../../src/errors.js";

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
    // invalid_device_id/not_admin predate leaveChat/getProfile/reportUser/
    // setChatMode/updateChatRoles (already returned by e.g. addParticipant/
    // generateInviteLink) but were never mapped until those methods were added.
    ["invalid_device_id", EvergramAuthError],
    ["not_admin", EvergramAccessDeniedError],
    ["unauthorized", EvergramAccessDeniedError],
    ["leave_not_allowed", EvergramValidationError],
    ["missing_fields", EvergramValidationError],
    ["invalid_participant", EvergramValidationError],
    ["invalid_chat_type", EvergramValidationError],
    ["last_admin_protection", EvergramValidationError],
    ["founder_protection", EvergramValidationError],
    ["ALREADY_PARTICIPANT", EvergramValidationError],
    // createChat/addParticipant: group participant-cap check.
    ["TOO_MANY_PARTICIPANTS", EvergramValidationError],
    // Device revocation: deliberately NOT EvergramAuthError on either of
    // these — requestWithReauth only retries EvergramAuthError, and
    // reconnect-and-retry can't fix a revoked device or a stale chat
    // version (see src/errors.ts's comments on these two classes).
    ["device_revoked", EvergramDeviceRevokedError],
    ["rotation_conflict", EvergramRotationError],
    ["rotation_required", EvergramRotationError],
    ["ROTATION_REQUIRED", EvergramRotationError],
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
