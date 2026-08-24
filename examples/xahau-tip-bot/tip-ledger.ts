import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface ProcessedTip {
  msgId: string;
  txHash: string;
  amount: string;
  currency: string;
  toAddress: string;
  ts: number;
}

// Bounds the file's growth for a long-running bot; a personal tip bot doing
// a handful of tips a day won't come close to this before the oldest
// entries age out, and losing very old idempotency records is an acceptable
// tradeoff against growing the file forever.
const MAX_ENTRIES = 5000;

// Read-modify-write plain JSON, same shape as
// _shared/visitor-session-store.ts. Fine for an example bot's traffic, not
// a pattern to scale to high volume. This is what makes `!tip` idempotent
// across restarts: without it, a redelivered mailbox message (or a
// crash-and-restart mid-processing) would resubmit an already-successful
// on-chain payment. It does NOT close every gap: a crash between
// sendXahPayment() succeeding and recordProcessedTip() actually writing is
// still possible and would still double-pay on redelivery. Closing that
// completely needs reconciling against the ledger's own tx history (e.g. by
// a memo), which is out of scope for this example.
export function loadProcessedTips(path: string): Map<string, ProcessedTip> {
  if (!existsSync(path)) return new Map();
  const entries: ProcessedTip[] = JSON.parse(readFileSync(path, "utf8"));
  return new Map(entries.map((entry) => [entry.msgId, entry]));
}

export function recordProcessedTip(
  path: string,
  processed: Map<string, ProcessedTip>,
  tip: ProcessedTip,
): void {
  processed.set(tip.msgId, tip);

  let entries = [...processed.values()];
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
    processed.clear();
    for (const entry of entries) processed.set(entry.msgId, entry);
  }

  writeFileSync(path, JSON.stringify(entries, null, 2));
}
