export { EvergramCore } from "./core";
export type { EvergramCoreOptions, EvergramDevice, EvergramChatMessage } from "./core";

export { EvergramBot } from "./bot";
export type { JoinRequestHandle, EvergramBotOptions } from "./bot";

export { generateWallet, walletFromSeed, buildAuthChallenge, signAuthChallenge } from "./wallet";
export type { EvergramWallet } from "./wallet";

export { generateDeviceKeypair, deriveDeviceId } from "./crypto";

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
} from "./errors";

export * from "./proto/evergram";
