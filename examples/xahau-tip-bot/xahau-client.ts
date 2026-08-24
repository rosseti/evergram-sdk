import {
  Client,
  RippledError,
  Wallet,
  dropsToXrp,
  xrpToDrops,
  type Payment,
  type TxResponse,
} from "xrpl";
import { EvergramWallet } from "../../src/index.js";

// Independent of index.ts's own DEBUG constant: each module here reads its
// own env config rather than importing shared state across files.
const DEBUG = process.env.TIPBOT_DEBUG === "true";

// The bot's chat identity and its on-chain funding wallet are the exact same
// key: EvergramWallet.seed (ripple-keypairs' generateSeed/deriveKeypair) and
// xrpl.Wallet.fromSeed derive from the same secp256k1 family-seed format, so
// no separate funding wallet/seed is needed. See src/wallet.ts.
export function fundingWalletFrom(wallet: EvergramWallet): Wallet {
  return Wallet.fromSeed(wallet.seed);
}

// account_info's "reserve" isn't returned per-account by rippled/Xahau. It's
// derived from server_state's base/owner reserve plus this account's
// OwnerCount. Xahau's base reserve is much higher than XRPL's (historically
// ~1 XAH vs XRPL's ~10 XRP, the order of magnitude reversed). Always ask the
// server rather than hardcode it, since both networks have changed theirs
// over time.
export async function getAvailableBalanceXah(client: Client, address: string): Promise<number> {
  try {
    const [accountInfo, serverState] = await Promise.all([
      client.request({ command: "account_info", account: address, ledger_index: "validated" }),
      client.request({ command: "server_state" }),
    ]);

    const ownerCount = accountInfo.result.account_data.OwnerCount;
    // reserve_base/reserve_inc from server_state are already in drops (unlike
    // the xrp-suffixed fields some other server_info shapes use).
    const { reserve_base = 0, reserve_inc = 0 } = serverState.result.state.validated_ledger ?? {};
    const reserveDrops = reserve_base + ownerCount * reserve_inc;

    const balanceDrops = Number(accountInfo.result.account_data.Balance);
    return Number(dropsToXrp(Math.max(0, balanceDrops - reserveDrops)));
  } catch (err) {
    // actNotFound: the account has never received enough XAH to be funded
    // above the reserve yet. A fresh bot wallet starts here, not an error.
    const data =
      err instanceof RippledError ? (err.data as { error?: string } | undefined) : undefined;
    if (data?.error === "actNotFound") return 0;
    throw err;
  }
}

const MAX_SUBMIT_ATTEMPTS = 4;

// xrpl.js's own autofill() defaults LastLedgerSequence to +20 ledgers, so a
// submission that never gets queued (see isRetryableSubmitError below) can
// sit in submitAndWait for a full 20 ledgers, up to ~80s at Xahau's ~4s
// close time, before it even fails once. A much shorter window here just
// makes a doomed attempt fail fast enough that retrying is worth it;
// autofill() honors LastLedgerSequence if it's already set on the tx
// instead of computing its own, so this isn't fighting it, it's the
// documented way to override it. Comfortably more than the 1-2 ledgers a
// normal submission validates within.
const LAST_LEDGER_OFFSET = 5;

// A telINSUF_FEE_P/LastLedgerSequence-exceeded failure here isn't ordinary
// fee escalation. It's a Hooks-enabled account (source or destination)
// requiring a per-hook execution fee on top of the base reference fee.
// autofill() has no visibility into that (it only reads the network's
// generic base fee via the `fee` command), so re-autofilling on retry
// computes the exact same too-low Fee every time and fails identically.
// Confirmed by testing: every attempt autofilled the same ~20 drops.
// There's no exposed RPC to ask "what would this specific tx actually
// cost", so instead of computing the real number, each retry forces a
// floor well above the last attempt's Fee and lets that converge
// empirically. Capped by the Client's own maxFeeXRP as a sanity ceiling:
// this must never spiral into paying an unreasonable fee for a tip.
const FEE_ESCALATION_FACTOR = 20;

export function isRetryableSubmitError(err: unknown): boolean {
  return err instanceof Error && /LastLedgerSequence/.test(err.message);
}

function dbg(message: string): void {
  if (DEBUG) console.debug(message);
}

// Surfaces a message that actually points at the likely cause, instead of
// xrpl.js's raw "LastLedgerSequence exceeded" text. That's accurate but
// says nothing about *why*, and the why here is almost always a
// Hooks-enabled account. maxFeeDrops in the message tells the owner whether
// we gave up because we hit our own safety ceiling or because more retries
// wouldn't have helped anyway (already at the fee cap).
export function exhaustedRetriesError(
  lastAttemptedFeeDrops: number,
  maxFeeDrops: number,
  cause: unknown,
): Error {
  return new Error(
    `never validated after ${MAX_SUBMIT_ATTEMPTS} attempts, escalating the fee up to` +
      ` ${lastAttemptedFeeDrops} drops (cap: ${maxFeeDrops}). This is almost always a` +
      ` Hooks-enabled account (sender or recipient) requiring more fee than a normal` +
      ` payment. Check its installed hooks on a Xahau explorer. Last error: ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

// One prepare-sign-submit cycle. `state.lastFeeDrops` is updated right
// after autofill() resolves, before submitAndWait (the part that actually
// throws on a retryable failure), so the caller's catch block still knows
// what fee this attempt tried even though the attempt itself failed.
async function attemptSubmit(
  client: Client,
  fundingWallet: Wallet,
  toAddress: string,
  amountXah: string,
  feeFloorDrops: number | undefined,
  state: { lastFeeDrops: number },
): Promise<TxResponse> {
  const attemptStartedAt = Date.now();
  const currentLedger = await client.getLedgerIndex();
  const tx: Payment = {
    TransactionType: "Payment",
    Account: fundingWallet.address,
    Destination: toAddress,
    Amount: xrpToDrops(amountXah),
    LastLedgerSequence: currentLedger + LAST_LEDGER_OFFSET,
    ...(feeFloorDrops ? { Fee: String(feeFloorDrops) } : {}),
  };

  // autofill() reads the connected server's own reported network_id and
  // stamps it onto the tx as NetworkID when required (Xahau's is >1024, so
  // it needs one; XRPL mainnet's doesn't). Nothing Xahau-specific to
  // hardcode here, xrpl.js already handles it generically per-server. It
  // fills Fee only when absent, so a forced floor from a previous attempt
  // survives this call untouched.
  const prepared = await client.autofill(tx);
  state.lastFeeDrops = Number(prepared.Fee ?? state.lastFeeDrops);
  dbg(
    `[xahau-tip-bot] DEBUG sendXahPayment: Fee=${prepared.Fee}` +
      ` LastLedgerSequence=${prepared.LastLedgerSequence} (+${Date.now() - attemptStartedAt}ms to prepare)`,
  );

  const signed = fundingWallet.sign(prepared);
  return client.submitAndWait(signed.tx_blob);
}

export async function sendXahPayment(
  client: Client,
  fundingWallet: Wallet,
  toAddress: string,
  amountXah: string,
): Promise<TxResponse> {
  const startedAt = Date.now();
  const maxFeeDrops = Number(xrpToDrops(client.maxFeeXRP));
  let feeFloorDrops: number | undefined;
  const state = { lastFeeDrops: 10 }; // xrpl's own reference fee floor, absent any autofill yet

  for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
    try {
      const result = await attemptSubmit(
        client,
        fundingWallet,
        toAddress,
        amountXah,
        feeFloorDrops,
        state,
      );
      dbg(
        `[xahau-tip-bot] DEBUG sendXahPayment: attempt ${attempt} settled (+${Date.now() - startedAt}ms total)`,
      );
      return result;
    } catch (err) {
      dbg(
        `[xahau-tip-bot] DEBUG sendXahPayment: attempt ${attempt} failed:` +
          ` ${err instanceof Error ? err.message : String(err)}`,
      );

      if (!isRetryableSubmitError(err)) throw err;
      if (attempt === MAX_SUBMIT_ATTEMPTS) {
        throw exhaustedRetriesError(state.lastFeeDrops, maxFeeDrops, err);
      }

      feeFloorDrops = Math.min(state.lastFeeDrops * FEE_ESCALATION_FACTOR, maxFeeDrops);
      dbg(`[xahau-tip-bot] DEBUG sendXahPayment: escalating fee floor to ${feeFloorDrops} drops`);
    }
  }

  // Unreachable: the loop above always either returns or throws.
  throw new Error("sendXahPayment: exhausted retries without a result");
}
