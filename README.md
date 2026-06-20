# @evergram/sdk

Headless SDK for building bots and programmatic integrations on the Evergram
protocol — direct XRPL wallet-signature authentication (no Xaman app needed),
end-to-end encrypted messaging, group management, and Discovery.

> **Status: not yet ready for public release.** The wallet-signature auth
> path this SDK depends on is new and is the first 100%-programmatic
> authentication mechanism in this system. See "Security status" below
> before pointing this at anything other than your own local/dev stack.

## Two layers

- **`EvergramCore`** — a 1:1, low-level mirror of the wire protocol. Every
  method maps directly to one gateway command. Use this when you need full
  control (custom protocols on top, non-chat integrations).
- **`EvergramBot`** — an ergonomic wrapper over `Core` (`bot.onMessage`,
  `bot.onJoinRequest`, `bot.reply`), in the spirit of Telegraf/Discord.js.
  Reconnection, re-authentication, key rotation and mailbox delivery are all
  handled for you. `bot.core` gives you the `Core` escape hatch any time.

Both reuse the same protobuf schema and `tweetnacl` E2EE primitives the
webapp client uses — see `src/proto/evergram.proto` (copied from
`webapp/app/proto/evergram.proto`; re-run `npm run protoc` here after the
canonical schema changes) and `src/crypto.ts`.

## Quick start

```ts
import { EvergramBot, generateWallet, generateDeviceKeypair, deriveDeviceId } from "@evergram/sdk";

const wallet = generateWallet(); // XRPL keypair — persist wallet.seed somewhere safe
const { pubHex, privHex } = generateDeviceKeypair();
const device = { deviceId: deriveDeviceId(pubHex), devicePubHex: pubHex, devicePrivHex: privHex };

const bot = new EvergramBot({ url: "ws://localhost:9000/api/ws", wallet, device, name: "MyBot" });
// `name` sets the bot's nickname (via setProfile) right after connecting,
// so chat UIs show "MyBot" instead of a raw rAddress. Optional — omit it
// and the bot just shows up as its address.

bot.onMessage(async (msg, chat) => {
  if (!msg.text) return;
  await bot.reply(msg, `you said: ${msg.text}`);
});

await bot.start();
console.log("online as", wallet.address);
```

Run the fuller version of this with persistence: `npm run example:echo-bot`.

## Examples

| Example | Shows |
|---|---|
| `examples/echo-bot` | The basics: identity bootstrap, listen, reply. |
| `examples/moderation-bot` | Group management — auto-approving join requests by rule. |
| `examples/webhook-bridge` | Bridging Evergram messages to an external HTTP endpoint. |

Run with `npm run example:<name>`. Each example persists its generated
wallet/device to `identity.json` next to it on first run (gitignored) so
re-running doesn't orphan chat history under a new identity.

## Auth flow (signed_message)

There is no Xaman app in a headless process, so bots authenticate by signing
a challenge directly with their XRPL wallet key:

1. The SDK builds `evergram-auth:{address}:{deviceId}:{unixMinuteTimestamp}`
   and signs it with the wallet's private key (`wallet.ts#signAuthChallenge`).
2. It sends `Auth { identity, proof: { signedMessage: { publicKeyHex, signatureHex } }, device }`.
3. The gateway (`webapp/app/gateway/helpers/verify-signed-message.ts`)
   recomputes the challenge itself for a small tolerance window around "now"
   (±2 minutes), verifies the signature against `publicKeyHex`, and confirms
   the address derived from `publicKeyHex` matches `identity.address`.
4. On a brand-new identity, the contract will reject the very first
   `authResponse` with `device_not_registered` — `EvergramCore` catches this
   automatically, calls `registerDevice`, and retries once. You don't need
   to handle this yourself.

**Replay window is intentional, not a bug.** The challenge is timestamp-bound,
not nonce-based — no server-side nonce storage is needed, but a captured
`signed_message` can be replayed successfully for the rest of its ~4-minute
tolerance window. This is an accepted v1 tradeoff (the channel is WSS/TLS,
and every auth attempt is separately rate-limited — see below), not
something to "discover" as a bug later. If your threat model needs stronger
replay protection, that would mean moving to a server-issued nonce — track
this as a protocol change, not an SDK-side workaround.

## Security status

This auth path has **not** gone through a dedicated security review yet.
Before relying on it for anything beyond local development:

1. `verify-signed-message.ts` needs its own focused review — it's the first
   fully programmatic auth path in this system, distinct from the existing
   Xaman-JWT path.
2. The replay-within-window behavior above must be explicitly tested (not
   assumed) against your deployment: confirm rejection past the tolerance
   window, and confirm — deliberately — that replay inside the window
   succeeds.
3. The gateway logs (`Logger.warn`) after 5 failed signature verifications
   for the same address within 10 minutes (`rateLimiter.ts`'s
   `recordSignedMessageAuthFailure`) — wire this into real alerting before
   depending on it as your only brute-force signal.

## Device keys & backup

**There is no key backup/recovery in this protocol today** — not an SDK
limitation, an inherited one (the webapp client has the exact same gap).
`device.devicePrivHex` is an X25519 key generated once
(`generateDeviceKeypair()`); every chat's symmetric key is sealed
specifically for it. Lose it, and that bot's chat history becomes
permanently unreadable — the wallet seed alone cannot recover it. Persist
both `wallet.seed` and the device keypair together, somewhere safer than
the examples' plaintext `identity.json` (a secrets manager, an encrypted
volume — your call, the SDK doesn't impose one).

## How chat keys actually move

Worth understanding before you build on this: the **gateway**, not the
contract and not any client, generates each chat's raw symmetric key and
seals it per recipient device (see `createChat.ts`/`addParticipant.ts`'s
`nacl.randomBytes(32)` + `encryptSymKeyForDevices`). It holds the plaintext
key only transiently, in memory, to seal it — never persisted or logged —
but it does see it. This is a deliberate, existing design choice in this
codebase, not something this SDK introduces or can change; mentioned here so
"end-to-end encrypted" doesn't surprise you later about exactly which hop is
trusted with what.

`EvergramCore` only ever receives the *sealed* key
(`chat.symKeyEncrypted[yourIdentityKey].devices[yourDeviceId]`) and opens it
locally with your device's private key (`crypto.ts#openSealedSymKey`) — the
SDK itself never sends a raw key anywhere.

## Access tiers

A freshly generated wallet starts in the contract's default tier
(`"early"` in local dev — see `contract/contract/access.config.json`), which
can create one-on-one chats but **not** groups (`group:create: false`).
`addParticipant`/`removeParticipant` on an *existing* group only require
chat-level admin/moderator role, not a tier capability — so a bot can manage
joins on a group it didn't create, as long as whoever created it adds the
bot as admin/moderator. `moderation-bot` assumes this setup; see the comment
at the top of `examples/moderation-bot/index.ts`.

## Rate limits

Mirrors `webapp/app/gateway/ws/rateLimiter.ts`, scoped per identity+device
unless noted:

| Action | Limit |
|---|---|
| `auth` (signed_message) | 10 attempts / 5 min |
| `sendMessage` | 5 / 10 sec |
| `createChat` | 3 / hour |
| `generateInviteLink` / `revokeInviteLink` | 5 / hour |
| `requestJoin` | 10 / hour |
| `resolveInvite` | 20 / min |
| `setChatDiscoverable` | 10 / hour |
| `listPublicChats` | 30 / min |

Exceeding any of these surfaces as `EvergramRateLimitError`.

## Typed errors

`Core`/`Bot` methods reject with one of these (`src/errors.ts`) instead of
raw string codes — `err.code` still carries the original gateway/contract
code if you need it:

| Class | Meaning |
|---|---|
| `EvergramAuthError` | Auth/session rejected (bad signature, expired session, etc). Core retries once on its own where it safely can. |
| `EvergramRateLimitError` | Hit one of the limits above. |
| `EvergramAccessDeniedError` | Missing capability/role for this action. |
| `EvergramRestrictedError` | Account flagged restricted (see `reputationUpdated`). |
| `EvergramNotFoundError` | Chat/device/etc not found. |
| `EvergramValidationError` | Bad input — including client-side checks (message size, participant count) that fail fast before a round-trip. |
| `EvergramTimeoutError` | No response within the request timeout. |
| `EvergramConnectionError` | Transport-level connect failure. |

## Known protocol limitations (not SDK bugs)

- No reject/deny RPC for join requests — only `addParticipant` (approve)
  clears a `pendingJoinRequests` entry. `JoinRequestHandle.deny()` exists
  and always throws, by design, so this isn't silently swallowed.
- No request-correlation IDs on the wire — `Core` matches responses to
  requests by field type, FIFO, mirroring the webapp client's own
  `_sendAndWaitResponse`. Concurrent calls of the *same* method type share
  this limitation; different method types don't collide.

## Verification

What's been run against the local stack (`docker-compose.yml`) while
building this:

- Fresh wallet auto-registers + authenticates with no manual `registerDevice` call.
- Full E2EE round trip: `createChat` → key derivation → `sendMessage` → decrypt on the other side.
- Key rotation: `chatKeyRotated` fires and post-rotation messages decrypt correctly.
- Forced disconnect → automatic reconnect → automatic re-authentication.
- `echo-bot` and `webhook-bridge` run end-to-end against the local gateway.
- `moderation-bot`'s push→event→`approve()`/`deny()` wiring verified directly (group creation needs a higher access tier than local dev's default — see "Access tiers").
- `npx tsc --noEmit` clean in both `webapp` and this package.
