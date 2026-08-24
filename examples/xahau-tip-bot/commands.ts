import { isValidClassicAddress } from "xrpl";

// Kept dependency-free of EvergramCore/xrpl.Client on purpose: this module is
// pure text-in/struct-out so it can be unit tested without a gateway or a
// Xahau node (see test/unit for the coverage).

export type TipTarget =
  | { kind: "reply"; identityKey: string }
  | { kind: "mention"; identityKey: string }
  | { kind: "address"; address: string };

export interface ParsedTip {
  amount: string;
  currency: string;
  target: TipTarget;
}

export type ParseTipResult = { ok: true; tip: ParsedTip } | { ok: false; error: string };

const AMOUNT_RE = /^\d+(\.\d+)?$/;
// XAH's smallest on-ledger unit is 1 drop = 0.000001 XAH, same as XRP — an
// amount with more precision than that is rejected by xrpl's xrpToDrops()
// at submit time regardless, but with a much less actionable error. Catching
// it here at parse time gives the caller a message that actually says why.
const MAX_DECIMALS = 6;

function validateAmount(raw: string): { ok: true; amount: string } | { ok: false; error: string } {
  if (!AMOUNT_RE.test(raw) || Number(raw) <= 0) {
    return { ok: false, error: `Invalid amount: ${raw}` };
  }

  const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
  if (decimals > MAX_DECIMALS) {
    return {
      ok: false,
      error: `Invalid amount: ${raw} — XAH allows at most ${MAX_DECIMALS} decimal places (smallest unit is 0.000001).`,
    };
  }

  return { ok: true, amount: raw };
}

// Parses everything after "!tip ". Three shapes, tried in order:
//   "!tip @<identityKey> <amount> [XAH]"  — explicit mention
//   "!tip <rAddress> <amount> [XAH]"      — raw ledger address
//   "!tip <amount> [XAH]"                 — no target token; falls back to
//                                            replySender (the author of the
//                                            message this command replied
//                                            to), like the original
//                                            XRPTipBot's reply-to-tip.
export function parseTipCommand(text: string, replySender: string | null): ParseTipResult {
  const parts = text.trim().split(/\s+/);
  const [, ...rest] = parts; // drop "!tip"

  if (rest.length === 0)
    return { ok: false, error: "Usage: !tip [<@identityKey>|<address>] <amount> [XAH]" };

  const first = rest[0];
  const isMention = first.startsWith("@");
  const isAddress = !isMention && isValidClassicAddress(first);

  if (isMention || isAddress) {
    const [amountRaw, currency = "XAH"] = rest.slice(1);
    if (!amountRaw) return { ok: false, error: "Invalid amount: (missing)" };
    const validated = validateAmount(amountRaw);
    if (!validated.ok) return validated;

    const target: TipTarget = isMention
      ? { kind: "mention", identityKey: first.slice(1) }
      : { kind: "address", address: first };

    return { ok: true, tip: { amount: validated.amount, currency, target } };
  }

  // No recognizable target token — treat rest[0] as the amount and fall
  // back to replySender.
  const [amountRaw, currency = "XAH"] = rest;
  const validated = validateAmount(amountRaw);
  if (!validated.ok) return validated;
  if (!replySender) {
    return {
      ok: false,
      error:
        "No target given — reply to the person's message, or use !tip @<identityKey>/<address> <amount>.",
    };
  }

  return {
    ok: true,
    tip: {
      amount: validated.amount,
      currency,
      target: { kind: "reply", identityKey: replySender },
    },
  };
}
