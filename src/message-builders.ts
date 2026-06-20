/**
 * message-builders.ts
 *
 * Typed constructors for the JSON envelopes message-content.ts parses —
 * mirrors webapp/app/lib/{payment-message,audio-message}.ts's "Build"
 * sections so bots send the same well-typed shape the webapp client does,
 * instead of hand-rolling envelope JSON inline.
 */

import { randomUUID } from "node:crypto";
import { bytesToBase64 } from "./crypto";

export function buildPaymentRequest(params: {
  // Override when the caller must know the id before the async send
  // resolves (e.g. to register a pending request without a race on
  // back-to-back messages) — defaults to a fresh one otherwise.
  requestId?: string;
  amount: string;
  currency: string;
  currencyId: string;
  note?: string;
  to: string;
  toIdentityKey: string;
}): string {
  const { requestId = randomUUID(), ...rest } = params;
  return JSON.stringify({ type: "payment_request" as const, requestId, ...rest });
}

export function buildPaymentReceipt(params: {
  requestId: string;
  txHash: string;
  amount: string;
  currency: string;
  currencyId: string;
  from: string;
  fromIdentityKey: string;
}): string {
  return JSON.stringify({ type: "payment_receipt" as const, ...params });
}

export function buildAudioMessage(params: {
  audioBytes: Uint8Array;
  mimeType: string;
  durationMs: number;
}): string {
  const { audioBytes, mimeType, durationMs } = params;

  return JSON.stringify({
    type: "audio" as const,
    mimeType,
    durationMs,
    size: audioBytes.length,
    payload: bytesToBase64(audioBytes),
  });
}
