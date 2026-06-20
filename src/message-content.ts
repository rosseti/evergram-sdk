/**
 * message-content.ts
 *
 * Canonical typing for what a decrypted message plaintext actually is.
 *
 * Plain text travels as a raw string; audio and payment messages travel as
 * a JSON envelope discriminated by `type` — the same field name and values
 * as the parsed MessageContent below, so there's no separate wire
 * vocabulary to translate. This module is the single place that turns
 * either shape into a discriminated union, so nothing else in the app needs
 * to prefix-check or JSON.parse decrypted text itself.
 */

export type TextContent = { type: "text"; text: string };

export type AudioContent = {
  type: "audio";
  mimeType: string; // e.g. "audio/webm" — whatever MediaRecorder produced
  durationMs: number;
  size: number; // raw byte count (before base64)
  payload: string; // base64-encoded raw audio bytes
};

export type PaymentRequestContent = {
  type: "payment_request";
  requestId: string; // stable ID used to correlate with receipt
  amount: string; // human-readable amount (e.g. "10.5")
  currency: string; // ticker for display (e.g. "XAH", "XRP", "EVR")
  currencyId: string; // id from currencies.ts (e.g. "EVR_XAHAU")
  note?: string;
  to: string; // ledger address of the person requesting payment
  toIdentityKey: string; // identity key of the requester
};

export type PaymentReceiptContent = {
  type: "payment_receipt";
  requestId: string; // matches the PaymentRequestContent.requestId
  txHash: string;
  amount: string;
  currency: string; // ticker
  currencyId: string; // id from currencies.ts
  from: string; // ledger address of the payer
  fromIdentityKey: string;
};

export type MessageContent =
  | TextContent
  | AudioContent
  | PaymentRequestContent
  | PaymentReceiptContent;

/**
 * Parse a decrypted message plaintext into a typed MessageContent.
 * This is the only place that should ever inspect the raw string to
 * determine message kind — everything else should switch on `.type`.
 */
export function parseMessageContent(text: string | undefined | null): MessageContent {
  if (!text) return { type: "text", text: text ?? "" };

  // Fast bail — avoids JSON.parse on the overwhelming majority of messages.
  if (!text.startsWith("{")) return { type: "text", text };

  try {
    const obj = JSON.parse(text);

    if (obj.type === "audio" && typeof obj.payload === "string") {
      return {
        type: "audio",
        mimeType: obj.mimeType,
        durationMs: obj.durationMs,
        size: obj.size,
        payload: obj.payload,
      };
    }

    if (obj.type === "payment_request") {
      return {
        type: "payment_request",
        requestId: obj.requestId,
        amount: obj.amount,
        currency: obj.currency,
        currencyId: obj.currencyId || "XAH", // legacy messages predate multi-currency support
        note: obj.note,
        to: obj.to,
        toIdentityKey: obj.toIdentityKey,
      };
    }

    if (obj.type === "payment_receipt") {
      return {
        type: "payment_receipt",
        requestId: obj.requestId,
        txHash: obj.txHash,
        amount: obj.amount,
        currency: obj.currency,
        currencyId: obj.currencyId || "XAH",
        from: obj.from,
        fromIdentityKey: obj.fromIdentityKey,
      };
    }
  } catch {
    // malformed JSON — treat as plain text
  }

  return { type: "text", text };
}

export function formatMessagePreview(content: MessageContent): string {
  switch (content.type) {
    case "audio": {
      const secs = Math.round(content.durationMs / 1000);
      return `🎤 Voice message (${secs}s)`;
    }
    case "payment_request": {
      const note = content.note ? ` · ${content.note}` : "";
      return `💰 Payment Request: ${content.amount} ${content.currency}${note}`;
    }
    case "payment_receipt":
      return `✅ Payment sent: ${content.amount} ${content.currency}`;
    case "text":
      return content.text;
  }
}
