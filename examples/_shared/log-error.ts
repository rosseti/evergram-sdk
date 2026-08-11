import { EvergramError } from "../../src/index.js";

// EvergramError messages (e.g. insufficient_account_balance) are already
// human-readable on their own; printing the full Error with its stack just
// buries that message under noise for something that isn't a bug. Unknown
// errors still get the full stack since there's no SDK-provided message to
// fall back on.
export function logBotError(prefix: string, err: unknown): void {
  if (err instanceof EvergramError) {
    console.error(`${prefix} ${err.message}`);
  } else {
    console.error(prefix, err);
  }
}
