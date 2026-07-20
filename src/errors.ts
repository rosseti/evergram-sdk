// Normalizes the ad hoc string codes scattered across the gateway's own
// handlers (ResponseStatus.code / Error.code on the wire) into a typed
// hierarchy.
// Callers do `catch (e) { if (e instanceof EvergramRateLimitError) ... }`
// instead of comparing magic strings.

export class EvergramError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message || code);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class EvergramAuthError extends EvergramError {}
export class EvergramRateLimitError extends EvergramError {}
export class EvergramAccessDeniedError extends EvergramError {}
export class EvergramRestrictedError extends EvergramError {}
export class EvergramNotFoundError extends EvergramError {}
export class EvergramValidationError extends EvergramError {}
export class EvergramTimeoutError extends EvergramError {}
export class EvergramConnectionError extends EvergramError {}

// This device was revoked (see handleAuth's status:"revoked" check and
// handleRevokeDevice in the contract) — terminal, not an auth hiccup.
// Deliberately its own class, not EvergramAuthError: requestWithReauth
// reconnects-and-retries on EvergramAuthError, which would just get
// rejected again forever for a revoked device. A bot author seeing this
// needs to re-register an entirely new device, not retry.
export class EvergramDeviceRevokedError extends EvergramError {}

// "rotation_conflict" (handleRotateChatVersion) and "rotation_required"/
// "ROTATION_REQUIRED" (sendMessage.ts, when the sender's own identity has
// fallen behind its required key epoch) — see the device-revocation design
// doc's protocol invariants. Also kept out of AUTH_CODES for the same
// reason as EvergramDeviceRevokedError: these aren't fixed by re-auth.
// sendMessage() already retries once automatically on ROTATION_REQUIRED;
// this is what surfaces if that single retry still doesn't resolve it.
export class EvergramRotationError extends EvergramError {}

const AUTH_CODES = new Set([
  "NOT_AUTHENTICATED",
  "invalid_authorization",
  "invalid_auth_payload",
  "invalid_device",
  // Returned by virtually every authenticated write handler server-side
  // (createChat, addParticipant, generateInviteLink, setChatMode,
  // updateChatRoles, ...) when the device id doesn't match the derived id
  // for its public key — pre-existing gap, not specific to any one method.
  "invalid_device_id",
  "missing_auth",
  "missing_auth_proof",
  "invalid_signed_message_proof",
  "invalid_signed_message_public_key",
  "invalid_signed_message_address",
  "invalid_signed_message_signature",
  "unsupported_chain_family",
]);

const DEVICE_REVOKED_CODES = new Set(["device_revoked"]);

const ROTATION_CODES = new Set(["rotation_conflict", "rotation_required", "ROTATION_REQUIRED"]);

const RATE_LIMIT_CODES = new Set(["RATE_LIMIT", "rate_limited", "RATE_LIMIT_CREATE_CHAT"]);

const ACCESS_DENIED_CODES = new Set([
  "ACCESS_DENIED",
  "access_denied",
  "capability_not_allowed",
  // Pre-existing gap: already returned by generateInviteLink/revokeInviteLink/
  // setChatDiscoverable, not just the new setChatMode.
  "not_admin",
  // updateChatRoles: "only admins can update roles".
  "unauthorized",
]);

const RESTRICTED_CODES = new Set(["ACCOUNT_RESTRICTED", "account_restricted"]);

const NOT_FOUND_CODES = new Set(["CHAT_NOT_FOUND", "chat_not_found", "device_not_registered"]);

const VALIDATION_CODES = new Set([
  "INVALID_PARTICIPANTS",
  "invalid_participants",
  "invalid_message_size",
  "INVALID_CHAT_NAME",
  "invalid_chat_name",
  "IDENTITY_HAS_NO_DEVICES",
  "DEVICE_MISSING_PUBKEY",
  "missing_field",
  // updateChatRoles uses the plural form for its own required-fields check —
  // a distinct string from "missing_field" above, not a typo.
  "missing_fields",
  "no_participants",
  // addParticipant: the gateway's own pre-check (handlers/inbound/
  // addParticipant.ts), not the contract — pre-existing gap, surfaced while
  // debugging the new chat-management tests, same class as not_admin/
  // invalid_device_id above.
  "ALREADY_PARTICIPANT",
  // leaveChat: one-on-one chats can't be left, group chats only.
  "leave_not_allowed",
  // updateChatRoles: target identity isn't a participant of this chat.
  "invalid_participant",
  // updateChatRoles: only group chats support role management.
  "invalid_chat_type",
  // updateChatRoles: a group must always keep at least one admin.
  "last_admin_protection",
  // updateChatRoles: the group founder can't be removed from admins.
  "founder_protection",
]);

// Builds the right EvergramError subclass for a gateway/contract response
// code. Falls back to the generic EvergramError for anything not in the
// known tables above rather than guessing — an unrecognized code means the
// caller still gets a typed error with .code set, just not narrowed further.
export function errorFromCode(code: string, message?: string): EvergramError {
  if (AUTH_CODES.has(code)) return new EvergramAuthError(code, message);
  if (DEVICE_REVOKED_CODES.has(code)) return new EvergramDeviceRevokedError(code, message);
  if (ROTATION_CODES.has(code)) return new EvergramRotationError(code, message);
  if (RATE_LIMIT_CODES.has(code)) return new EvergramRateLimitError(code, message);
  if (ACCESS_DENIED_CODES.has(code)) return new EvergramAccessDeniedError(code, message);
  if (RESTRICTED_CODES.has(code)) return new EvergramRestrictedError(code, message);
  if (NOT_FOUND_CODES.has(code)) return new EvergramNotFoundError(code, message);
  if (VALIDATION_CODES.has(code)) return new EvergramValidationError(code, message);
  return new EvergramError(code, message);
}
