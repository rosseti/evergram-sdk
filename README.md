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
  Reconnection, re-authentication, key rotation, mailbox delivery, and
  rediscovering chats you were already in are all handled for you. `bot.core`
  gives you the `Core` escape hatch any time.

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
| `examples/paywall-bot` | Monetization — gating a managed group behind a one-time payment_request/payment_receipt exchange. |

Run with `npm run example:<name>`. Each example persists its generated
wallet/device to `identity.json` next to it on first run (gitignored) so
re-running doesn't orphan chat history under a new identity.

## Auth flow (signed_message)

There is no Xaman app in a headless process, so bots authenticate by signing
a per-connection challenge directly with their XRPL wallet key:

1. Right after the WebSocket opens, the gateway pushes `ServerMessage.authChallenge { nonce }`
   — a random value generated for *this connection only*, before the SDK
   sends anything. `EvergramCore.authenticate()` waits for it.
2. The SDK builds `evergram-auth:{address}:{deviceId}:{nonce}` and signs it
   with the wallet's private key (`wallet.ts#signAuthChallenge`).
3. It sends `Auth { identity, proof: { signedMessage: { publicKeyHex, signatureHex } }, device }`.
4. The gateway (`webapp/app/gateway/helpers/verify-signed-message.ts`)
   recomputes the same challenge from the nonce *it* issued for this
   connection, verifies the signature against `publicKeyHex`, and confirms
   the address derived from `publicKeyHex` matches `identity.address`.
5. On a brand-new identity, the contract will reject the very first
   `authResponse` with `device_not_registered` — `EvergramCore` catches this
   automatically, calls `registerDevice`, and retries once. You don't need
   to handle this yourself (and it doesn't need a new nonce — see below).

**The nonce is single-use and connection-scoped — no cross-connection
replay.** It's generated server-side, held only in memory tied to that one
WebSocket connection, and consumed (deleted) on the first auth attempt,
success or failure. A signature captured for one connection cannot be
replayed on a different connection — the gateway only ever compares against
the nonce *it* issued for *that* connection, which is gone the moment it's
used (or the connection closes). Any auth failure means reconnecting for a
fresh nonce; there is deliberately no "retry without reconnecting" path.
This replaced an earlier timestamp-bucket scheme that had a multi-minute,
cross-network replay window — found and closed via a dedicated security
review before this SDK's first real use.

## Security status

A dedicated security review of this auth path found no authentication-bypass
vulnerability. The one design issue it surfaced (timestamp-based challenge
replayable across connections) has been fixed — see above. Two more issues
were found and fixed in a follow-up review since:

1. `allowSignedMessageAuth`'s rate limit was keyed by `remoteIdKey:deviceId`,
   and `deviceId` is self-asserted in the same `Auth` payload being
   authenticated — an attacker could mint a fresh budget every attempt by
   rotating it. Now keyed by address alone (`rateLimiter.ts`), matching how
   the failure counter below was already keyed.
2. The brute-force alert (`recordSignedMessageAuthFailure`) logged via
   `Logger.warn`, which is silenced by default in production — the alert
   never actually surfaced anywhere production logs were watched. Now
   `Logger.error` (never silenced) plus an investigable, severity-tagged
   Security Events panel in the `hpmgr` admin UI — no longer "just a log line."

Still worth knowing before relying on this beyond local development:

1. The Security Events panel is pull, not push — nobody is paged
   automatically, an admin has to open it. A real push channel (e.g. a
   webhook) is a deliberate follow-up, not done yet — blocked on picking a
   destination that doesn't mean baking a long-lived secret into every
   Evernode node's container.
2. This is still the first fully programmatic auth path in this system
   (distinct from the existing Xaman-JWT path) — treat any further change to
   `verify-signed-message.ts`, `rateLimiter.ts`, or the `AuthChallenge`
   handshake as worth its own focused review, not bundled into an unrelated
   PR (this review session itself touched all three).

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
| `sendTyping` (`isTyping: true`) | 1 / 2 sec, excess silently dropped (no error) |
| `createChat` | 3 / hour |
| `generateInviteLink` / `revokeInviteLink` | 5 / hour |
| `requestJoin` | 10 / hour |
| `resolveInvite` | 20 / min |
| `setChatDiscoverable` | 10 / hour |
| `listPublicChats` | 30 / min |

`leaveChat`, `getProfile`, `reportUser`, `setChatMode`, and `updateChatRoles`
have **no gateway-level rate limit today** — not an oversight being glossed
over, just not implemented yet; noted here so the absence from this table
isn't mistaken for "covered, not worth mentioning."

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

## API reference

Quick lookup of the full surface — see the sections above for the *why*
behind auth, encryption, and access tiers; this is just *what's callable*.

### `EvergramCore`

The 1:1 protocol mirror. Every method sends one request and resolves with
the matching response (or rejects with a [typed error](#typed-errors)),
except where noted as fire-and-forget.

| Method | Description |
|---|---|
| `new EvergramCore(opts: EvergramCoreOptions)` | Constructs the client. Doesn't connect by itself — call `connect()`. |
| `connect(): Promise<void>` | Opens the WebSocket and completes the [signed_message auth flow](#auth-flow-signed_message). Resolves once authenticated; self-heals device registration on a brand-new identity. |
| `close(): void` | Closes the connection. Does not affect persisted identity/keys. |
| `registerDevice()` | Registers this device for the current identity. Normally unnecessary — `connect()` does this for you on first use. |
| `setProfile(opts: { nickname?, avatarUrl?, bio? })` | Sets this identity's profile fields. No tier/capability gate. |
| `getProfile(remoteIdentity: string)` | Reads another identity's profile (`nickname`/`avatarUrl`/`bio`). |
| `createChat(type: "one-on-one" \| "group", participants: string[], meta?)` | Creates a chat. `participants` must include your own identity key and at least one other; groups need the `group:create` capability ([Access tiers](#access-tiers)). |
| `acceptChatRequest(fromIdentity: string)` | Accepts a pending one-on-one request, when the recipient has `requireChatApproval` on. |
| `acceptGroupInvite(chatId: string)` | Joins a group you were invited to, under the same approval gate. |
| `declineGroupInvite(chatId: string)` | Declines one invite only — does not block the inviter. |
| `getPendingChatRequests(): PendingChatRequest[]` | Locally cached one-on-one requests awaiting your decision. |
| `getPendingGroupInvites(): PendingGroupInvite[]` | Locally cached group invites awaiting your decision. |
| `blockIdentity(targetIdentity: string)` | Blocks an identity; also clears any pending chat request from them. |
| `unblockIdentity(targetIdentity: string)` | Reverses `blockIdentity`. |
| `updatePrivacySettings(requireChatApproval: boolean)` | Toggles whether new one-on-one chats/group invites need your explicit accept. |
| `sendMessage(chatId: string, text: string)` | Encrypts and sends a text message. |
| `sendTyping(chatId: string, isTyping: boolean)` | Fire-and-forget typing indicator — no return value. Gateway-throttled, see [Rate limits](#rate-limits). |
| `addParticipant(chatId: string, remoteIdentity: string)` | Adds a participant to an existing chat — also how `JoinRequestHandle.approve()` is implemented. |
| `removeParticipant(chatId: string, remoteIdentity: string)` | Removes a participant. |
| `leaveChat(chatId: string)` | Leaves a group chat. Rejected with `leave_not_allowed` for one-on-one chats. |
| `updateChatRoles(chatId, roles: { admins: string[], moderators: string[] })` | Replaces a group's full admin/moderator lists (not a delta) — group chats only. |
| `setChatMode(chatId, opts: { moderated: boolean })` | Toggles a group's moderated flag. |
| `reportUser(targetIdentity: string, reason: string)` | Flags an identity for abuse; may affect their reputation score. |
| `generateInviteLink(chatId, opts?: { expiresAt?, maxUses? })` | Creates a shareable invite code for a chat. Admin-only. |
| `revokeInviteLink(chatId: string)` | Invalidates a chat's current invite code. Admin-only. |
| `resolveInvite(inviteCode: string)` | Looks up what an invite code points to, without joining. |
| `requestJoin(inviteCode: string)` | Requests to join via an invite code — surfaces as a `joinRequested` event to the chat's admins/moderators. |
| `setChatDiscoverable(chatId, discoverable: boolean, category?)` | Lists/unlists a group in public discovery. Admin-only. |
| `listPublicChats(category?: string)` | Browses discoverable public groups. |
| `syncChats(): void` | Fire-and-forget resync of chats/keys. Normally unnecessary — `connect()` calls this for you on every connect/reconnect. |
| `getChat(chatId: string): ChatInfo \| undefined` | Locally cached chat metadata (participants, roles, `chatVersion`, etc). |
| `isRestricted: boolean` | Set from `reputationUpdated`/auth pushes — true if the contract has flagged this account restricted. |
| `profile?: Profile`, `profileStatus?: string` | The profile/status last reported back by `authResponse` — `profileStatus` is `"complete"` or `"missing_nickname"`. |

**Events** (`core.on(event, handler)`): `connected`, `authenticated`,
`disconnected`, `reconnecting` (attempt number), `message`
(`EvergramChatMessage`), `typing`, `delivery`, `chatKeyRotated` (`{chatId}`),
`joinRequested`, `chatRequestReceived`, `groupInviteReceived`, `restricted`
(`ReputationUpdated`), `error`.

### `EvergramBot`

The ergonomic wrapper described in [Two layers](#two-layers). `bot.core`
exposes the full `EvergramCore` surface above for anything not covered here.

| Method | Description |
|---|---|
| `new EvergramBot(opts: EvergramBotOptions)` | Constructs the bot — same options as `EvergramCore`, plus optional `name`. |
| `start(): Promise<void>` | Connects and authenticates; applies `name` via `setProfile` only if it differs from the nickname `authResponse` already reports. |
| `stop(): void` | Closes the connection. |
| `onMessage(handler): () => void` | Subscribes to incoming chat messages. Returns an unsubscribe function. |
| `onJoinRequest(handler): () => void` | Subscribes to join requests on chats this bot administers/moderates. `req.approve()`/`req.deny()` map to `addParticipant`/a permanent throw (no reject RPC exists — see [Known protocol limitations](#known-protocol-limitations-not-sdk-bugs)). |
| `onChatRequest(handler): () => void` | Subscribes to pending one-on-one requests (including ones already pending at connect time). `req.approve()`/`req.deny()` map to `acceptChatRequest`/`blockIdentity`. |
| `onGroupInvite(handler): () => void` | Subscribes to pending group invites (including ones already pending at connect time). `req.approve()`/`req.deny()` map to `acceptGroupInvite`/`declineGroupInvite`. |
| `reply(msg, text)` | Shorthand for `core.sendMessage(msg.chatId, text)`. |

## Known protocol limitations (not SDK bugs)

- No reject/deny RPC for join requests — only `addParticipant` (approve)
  clears a `pendingJoinRequests` entry. `JoinRequestHandle.deny()` exists
  and always throws, by design, so this isn't silently swallowed.
- No request-correlation IDs on the wire — `Core` matches responses to
  requests by field type, FIFO, mirroring the webapp client's own
  `_sendAndWaitResponse`. Concurrent calls of the *same* method type share
  this limitation; different method types don't collide.

## Testing

Two layers — re-run both whenever you touch the wire protocol, the auth
handshake, or `core.ts`'s request/response plumbing, instead of re-deriving
verification from scratch by hand:

```bash
npm test                 # unit — pure logic, no network, runs anywhere
npm run test:integration # needs the local stack up at ws://localhost:9000/api/ws (override with EVERGRAM_TEST_WS_URL)
npm run typecheck:test   # typechecks test/ too — `typecheck` only covers src/examples
```

`group:create` is gated behind the beta/ga/admin tiers (see
`contract/contract/access.config.json`) — a freshly generated wallet can't
create groups, so the `updateChatRoles`/`setChatMode`/`leaveChat` group tests
in `chat-management.test.ts` are skipped unless `EVERGRAM_TEST_ADMIN_SEED` is
set to a wallet seed already granted one of those tiers on your local stack.
Prefer `admin` (no devices/chats limit) over `beta` (`devices: 3`,
`chats: 20`) — the same wallet address gets reused across every local run of
that test file, so a capped tier will eventually exhaust its limit.

**Unit** (`test/unit/`): `wallet.ts`/`crypto.ts` against the real `xrpl`/
`tweetnacl` libraries, `identity.ts`'s key format, the typed-error mapping
table, and a byte-for-byte diff between this package's `evergram.proto` and
webapp's canonical copy — catches exactly the "forgot to re-sync after
changing the schema" mistake the manual-copy step invites.

**Integration** (`test/integration/`): drives the real local gateway over a
real WebSocket, deliberately not mocked — a mock would only prove the SDK
agrees with itself, and the actual risk here is SDK/gateway drift (the
nonce handshake, the contract's response shapes). The cost is needing the
local stack up and ~90s of wall-clock time; a single local HotPocket node
has a real consensus roundtime (`.contractdata/cfg/hp.cfg`), so these files
run sequentially rather than in parallel to avoid contending with
themselves.

- `auth.test.ts` — the regression suite for the nonce-based replay-window
  fix: self-heal register+auth, a signature captured on one connection
  rejected when replayed on another, a second auth attempt on the same
  connection rejected once its nonce is consumed. If this ever goes red,
  the replay window is probably back.
- `messaging.test.ts` — full E2EE round trip: `createChat` → key derivation
  on both sides → `sendMessage` → decrypt.
- `reconnect.test.ts` — Transport's automatic reconnect-with-backoff after a
  dropped connection, and `requestWithReauth`'s recovery via a fresh
  connection.

**Caught two real bugs while being written, not while being planned** —
exactly the case for having this suite instead of re-deriving verification
by hand each time:

1. `requestWithReauth`'s same-connection reauth (meant to recover from a
   24h-stale session JWT on a connection that never dropped) hung
   indefinitely after the nonce redesign, since the gateway only ever pushes
   `AuthChallenge` once, at connection-open. Fixed in `core.ts` to recover
   via a fresh connection instead, which always gets a fresh nonce —
   `reconnect.test.ts` pins this down.
2. A fresh `EvergramCore` — including every restart of a long-running bot
   process — started with empty `chats`/`symKeys` maps and **nothing ever
   re-populated them**: neither `EvergramBot.start()` nor the examples called
   `syncChats()`, unlike the webapp client (which calls it right after auth
   — see `evergram-client.ts`'s `ensureAuthSessionReady`). Any message for a
   chat created before the bot's current process started was silently
   swallowed: queued in `pendingEnvelopes` and never drained, no error, no
   log. Fixed by having `Core` call `syncChats()` itself right after every
   successful `authenticate()` (initial connect *and* every reconnect) —
   `messaging.test.ts`'s "rediscovers a pre-existing chat... after a fresh
   process restart" test reproduces the exact symptom and pins the fix down.

`npx tsc --noEmit` is clean in both `webapp` and this package.
