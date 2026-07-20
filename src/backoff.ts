// Exponential backoff with jitter, capped — shared formula for anything in
// this SDK that needs to space out retries against the gateway. Pure
// function so the delay curve itself is unit-testable without needing a
// real timer/socket in the loop.
export interface BackoffOptions {
  /** Delay for attempt 1, in ms. */
  baseMs: number;
  /** Upper bound on the returned delay, in ms. */
  capMs: number;
  /** Max random jitter added on top of the exponential delay, in ms. */
  jitterMs: number;
}

export function computeBackoffMs(attempt: number, opts: BackoffOptions): number {
  const exponential = opts.baseMs * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * opts.jitterMs);
  return Math.min(exponential + jitter, opts.capMs);
}
