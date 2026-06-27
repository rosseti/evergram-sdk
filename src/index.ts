export { EvergramCore } from "./core";
export type {
  EvergramCoreOptions,
  EvergramDevice,
  EvergramChatMessage,
  EvergramReaction,
  EvergramMessageEdited,
  EvergramMessageDeleted,
  EvergramVisitorMessage,
  EvergramVisitorReaction,
  EvergramVisitorMessageEdited,
  EvergramVisitorMessageDeleted,
  EvergramVisitorTyping,
  EvergramVisitorRoomRequested,
  EvergramVisitorStatusChanged,
  EvergramVisitorRoomTimedOut,
} from "./core";

// Widget-visitor chat — see [[evergram-sdk-relay-duplication]] memory.
// EphemeralRelaySession itself stays internal; only the plain data shapes
// bot authors need for handler signatures are public.
export type {
  EphemeralRelayStatus,
  EphemeralTextEvent,
  EphemeralReactEvent,
  EphemeralEditEvent,
  EphemeralRemoveEvent,
} from "./ephemeral-relay-session";

export { parseMessageContent, formatMessagePreview } from "./message-content";
export type {
  MessageContent,
  TextContent,
  AudioContent,
  PaymentRequestContent,
  PaymentReceiptContent,
} from "./message-content";

export { buildPaymentRequest, buildPaymentReceipt, buildAudioMessage } from "./message-builders";

export { EvergramBot } from "./bot";
export type {
  JoinRequestHandle,
  ChatRequestHandle,
  GroupInviteHandle,
  EvergramBotOptions,
  VisitorSessionHandle,
} from "./bot";

export { generateWallet, walletFromSeed, buildAuthChallenge, signAuthChallenge } from "./wallet";
export type { EvergramWallet } from "./wallet";

export { generateDeviceKeypair, deriveDeviceId, hexToBytes, bytesToHex } from "./crypto";

export { identityKey, parseIdentityKey } from "./identity";

export {
  EvergramError,
  EvergramAuthError,
  EvergramRateLimitError,
  EvergramAccessDeniedError,
  EvergramRestrictedError,
  EvergramNotFoundError,
  EvergramValidationError,
  EvergramTimeoutError,
  EvergramConnectionError,
  EvergramDeviceRevokedError,
  EvergramRotationError,
} from "./errors";

export * from "./proto/evergram";
