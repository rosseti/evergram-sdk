export { EvergramCore } from "./core.js";
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
  EvergramVisitorChannelParticipantJoined,
  EvergramVisitorChannelParticipantLeft,
  EvergramVisitorChannelModeChanged,
  EvergramVisitorKicked,
} from "./core.js";

// Widget-visitor chat — see [[evergram-sdk-relay-duplication]] memory.
// EphemeralRelaySession itself stays internal; only the plain data shapes
// bot authors need for handler signatures are public.
export type {
  EphemeralRelayStatus,
  EphemeralTextEvent,
  EphemeralReactEvent,
  EphemeralEditEvent,
  EphemeralRemoveEvent,
  EphemeralModerationState,
} from "./ephemeral-relay-session.js";

export { parseMessageContent, formatMessagePreview } from "./message-content.js";
export type {
  MessageContent,
  TextContent,
  AudioContent,
  PaymentRequestContent,
  PaymentReceiptContent,
} from "./message-content.js";

export { buildPaymentRequest, buildPaymentReceipt, buildAudioMessage } from "./message-builders.js";

export { EvergramBot } from "./bot.js";
export type {
  JoinRequestHandle,
  ChatRequestHandle,
  GroupInviteHandle,
  EvergramBotOptions,
  VisitorSessionHandle,
} from "./bot.js";

export { generateWallet, walletFromSeed, buildAuthChallenge, signAuthChallenge } from "./wallet.js";
export type { EvergramWallet } from "./wallet.js";

export { generateDeviceKeypair, deriveDeviceId, hexToBytes, bytesToHex } from "./crypto.js";

export { identityKey, parseIdentityKey } from "./identity.js";

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
  EvergramInsufficientBalanceError,
} from "./errors.js";

export * from "./proto/evergram.js";
