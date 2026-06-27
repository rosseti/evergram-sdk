# @evergram/sdk

Headless SDK for building bots and programmatic integrations on the Evergram
protocol — direct XRPL wallet-signature authentication (no Xaman app needed),
end-to-end encrypted messaging (including reactions, edit, and delete), chat
key rotation, embeddable-widget management, anonymous widget-visitor chat,
group management, and Discovery.

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
| `examples/visitor-bot` | Widget-visitor chat — echoes back anonymous visitor messages on an existing widget, and persists active rooms to disk so a restart can reclaim them (see `EvergramCore.registerVisitorSession`). Open the printed `/widget/{id}` URL in a browser to act as the visitor. |

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
SDK itself never sends a raw key anywhere. `rotateChatVersion()` asks the
gateway to mint and reseal a fresh key for a chat's current participants
on demand; `sendMessage()` also triggers this automatically (one retry) if
the contract rejects a send as `ROTATION_REQUIRED`.

Widget-visitor rooms (see "Widgets & visitor chat" below) work differently:
the symmetric key there is generated once per room and sealed only for the
widget owner's registered devices — there is no contract-side chat object,
no rotation, and no persistence, so losing every device that has the key
(or letting the process exit without `registerVisitorSession`-ing it first)
ends that conversation for good.

## Access tiers

A freshly generated wallet starts in the contract's default tier
(`"early"` in local dev — see `contract/contract/access.config.json`), which
can create one-on-one chats but **not** groups (`group:create: false`) and
**cannot create widgets** (widgets require the `beta`/`ga`/`admin` tier or a
`pro` subscription — a freshly generated wallet gets `widgets_not_available`
from `createWidget`). `addParticipant`/`removeParticipant` on an *existing*
group only require chat-level admin/moderator role, not a tier capability —
so a bot can manage joins on a group it didn't create, as long as whoever
created it adds the bot as admin/moderator. `moderation-bot` assumes this
setup; see the comment at the top of `examples/moderation-bot/index.ts`.
Tiers that *can* create widgets still cap how many via `access.limits.widgets`
(e.g. 5 on `beta`/`pro`) — exceeding it returns `widget_limit_reached`.

## Rate limits

Mirrors `webapp/app/gateway/ws/rateLimiter.ts`, scoped per identity+device
unless noted:

| Action | Limit |
|---|---|
| `auth` (signed_message) | 10 attempts / 5 min |
| `sendMessage` | 5 / 10 sec |
| `reactToMessage` / `removeReaction` | 30 / 10 sec |
| `editMessage` / `deleteMessage` (same envelope type) | 5 / 60 sec |
| `sendTyping` (`isTyping: true`) | 1 / 2 sec, excess silently dropped (no error) |
| `createChat` | 3 / hour |
| `generateInviteLink` / `revokeInviteLink` | 5 / hour |
| `requestJoin` | 10 / hour |
| `resolveInvite` | 20 / min |
| `setChatDiscoverable` | 10 / hour |
| `listPublicChats` | 30 / min |

`leaveChat`, `getProfile`, `reportUser`, `setChatMode`, `updateChatRoles`,
`rotateChatVersion`, every widget method (`createWidget`/`deleteWidget`/
`updateWidget`/`listWidgets`/`getWidgetInfo`), and every widget-visitor relay
action (`sendVisitorMessage`/`reactToVisitorMessage`/`editVisitorMessage`/
`removeVisitorMessage`/`sendVisitorTyping`/`endVisitorRoom`) have **no
gateway-level rate limit today** — not an oversight being glossed over, just
not implemented yet; noted here so the absence from this table isn't
mistaken for "covered, not worth mentioning." (Widget *creation itself* is
still bounded indirectly by the per-tier `widgets` count limit above.)

Exceeding any of the listed limits surfaces as `EvergramRateLimitError`.

## Typed errors

`Core`/`Bot` methods reject with one of these (`src/errors.ts`) instead of
raw string codes — `err.code` still carries the original gateway/contract
code if you need it:

| Class | Meaning |
|---|---|
| `EvergramAuthError` | Auth/session rejected (bad signature, expired session, etc). `Core` retries once on its own where it safely can. |
| `EvergramDeviceRevokedError` | This device was revoked (see device management) — terminal, not an auth hiccup. Register a new device instead of retrying. |
| `EvergramRotationError` | A chat's key needed to rotate and the single automatic rotate-and-resend `sendMessage()` already attempts also failed. |
| `EvergramRateLimitError` | Hit one of the limits above. |
| `EvergramAccessDeniedError` | Missing capability/role for this action. |
| `EvergramRestrictedError` | Account flagged restricted (see `reputationUpdated`). |
| `EvergramNotFoundError` | Chat/device/widget/visitor-room/etc not found. |
| `EvergramValidationError` | Bad input — including client-side checks (message size, participant count, malformed device key) that fail fast before a round-trip. |
| `EvergramTimeoutError` | No response within the request timeout. |
| `EvergramConnectionError` | Transport-level connect failure. |

Two widget-specific codes — `widgets_not_available` (see "Access tiers")
and `widget_limit_reached` — aren't narrowed into one of the subclasses
above yet; they still reject with a typed `EvergramError` whose `.code`
carries the exact string, just not via `instanceof` on a more specific
class.

## Message content & builders

A decrypted message's `text` is either plain text or a small JSON envelope
(audio, payment request, payment receipt) discriminated by a `type` field —
`message-content.ts` is the single place that tells those apart, mirroring
`webapp/app/lib/message-content.ts` exactly so the two clients never drift
on what a given wire payload means.

```ts
import { parseMessageContent, formatMessagePreview } from "@evergram/sdk";

bot.onMessage((msg) => {
  switch (msg.content.type) {
    case "text":
      console.log(msg.content.text);
      break;
    case "payment_request":
      console.log(`payment requested: ${msg.content.amount} ${msg.content.currency}`);
      break;
    // "audio", "payment_receipt" — see MessageContent in src/message-content.ts
  }

  console.log(formatMessagePreview(msg.content)); // human-readable one-liner, e.g. for logs
});
```

`msg.content`/`edit.content` (`EvergramChatMessage`/`EvergramMessageEdited`)
are already parsed for you — `parseMessageContent` is exported mainly for
re-parsing `getChat()`-cached text or your own stored history.
`buildPaymentRequest`/`buildPaymentReceipt`/`buildAudioMessage` construct the
matching JSON string to pass into `sendMessage()`, instead of hand-rolling
the envelope shape yourself (see `examples/paywall-bot` for a full
request/receipt exchange).

## Widgets & visitor chat

A **widget** is a shareable, embeddable chat surface (see the webapp's
`/developers/embed` docs) — anonymous visitors talk to it with no account,
wallet, or install, and never see the widget owner's real identity. From the
SDK side, the owner/bot manages widgets and the resulting conversations:

- `createWidget` / `deleteWidget` / `updateWidget` / `listWidgets` /
  `getWidgetInfo` manage the widget entities themselves (gated by access
  tier — see "Access tiers").
- When a visitor opens a widget and sends their first message, this bot
  (if one of its devices is online) receives a `visitorRoomRequested` event
  carrying an already-decrypted `firstMessage` and the room's symmetric key.
  `EvergramBot.onVisitorRoomRequested` wraps this into a `VisitorSessionHandle`
  (`reply`/`react`/`edit`/`remove`/`typing`/`end`) reused across every
  subsequent `onVisitorMessage`/`onVisitorReaction`/`onVisitorMessageEdited`/
  `onVisitorMessageDeleted`/`onVisitorTyping` callback for that same
  `roomToken`.
- These rooms are **not** contract-backed chats — no offline inbox, no
  persistence, no rotation. If this process restarts, it has no way to
  recover an in-progress room on its own; persist
  `{roomToken, symKey, widgetId, visitorLabel, origin}` yourself (from the
  `visitorRoomRequested` event) and call `core.registerVisitorSession(...)`
  with it *before* `connect()`/`start()` on the next run — see
  `examples/visitor-bot` for the full pattern, including cleanup on
  `visitorStatusChanged` reporting `"closed"`.
- `onVisitorRoomTimedOut` fires in the rarer race where an owner device was
  online when the room was created but disconnected before actually joining
  it — the common "no device online at all" case is rejected synchronously
  to the visitor and this bot never hears about it.

## API reference

Quick lookup of the full surface — see the sections above for the *why*
behind auth, encryption, access tiers, and widgets/visitor chat; this is
just *what's callable*.

### `EvergramCore`

The 1:1 protocol mirror. Every method sends one request and resolves with
the matching response (or rejects with a [typed error](#typed-errors)),
except where noted as fire-and-forget.

**Connection & profile**

| Method | Description |
|---|---|
| `new EvergramCore(opts: EvergramCoreOptions)` | Constructs the client. Doesn't connect by itself — call `connect()`. |
| `connect(): Promise<void>` | Opens the WebSocket and completes the [signed_message auth flow](#auth-flow-signed_message). Resolves once authenticated; self-heals device registration on a brand-new identity. |
| `close(): void` | Closes the connection. Does not affect persisted identity/keys. |
| `registerDevice()` | Registers this device for the current identity. Normally unnecessary — `connect()` does this for you on first use. |
| `setProfile(opts: { nickname?, avatarUrl?, bio? })` | Sets this identity's profile fields. No tier/capability gate. |
| `getProfile(remoteIdentity: string)` | Reads another identity's profile (`nickname`/`avatarUrl`/`bio`). |
| `isRestricted: boolean` | Set from `reputationUpdated`/auth pushes — true if the contract has flagged this account restricted. |
| `profile?: Profile`, `profileStatus?: string` | The profile/status last reported back by `authResponse` — `profileStatus` is `"complete"` or `"missing_nickname"`. |

**Chats — lifecycle, requests & privacy**

| Method | Description |
|---|---|
| `createChat(type: "one-on-one" \| "group", participants: string[], meta?)` | Creates a chat. `participants` must include your own identity key and at least one other; groups need the `group:create` capability ([Access tiers](#access-tiers)). |
| `acceptChatRequest(fromIdentity: string)` | Accepts a pending one-on-one request, when the recipient has `requireChatApproval` on. |
| `acceptGroupInvite(chatId: string)` | Joins a group you were invited to, under the same approval gate. |
| `declineGroupInvite(chatId: string)` | Declines one invite only — does not block the inviter. |
| `getPendingChatRequests(): PendingChatRequest[]` | Locally cached one-on-one requests awaiting your decision. |
| `getPendingGroupInvites(): PendingGroupInvite[]` | Locally cached group invites awaiting your decision. |
| `blockIdentity(targetIdentity: string)` | Blocks an identity; also clears any pending chat request from them. |
| `unblockIdentity(targetIdentity: string)` | Reverses `blockIdentity`. |
| `updatePrivacySettings(requireChatApproval: boolean)` | Toggles whether new one-on-one chats/group invites need your explicit accept. |
| `leaveChat(chatId: string)` | Leaves a group chat. Rejected with `leave_not_allowed` for one-on-one chats. |
| `rotateChatVersion(chatId: string)` | Asks the gateway to mint and reseal a fresh symmetric key for the chat's current participants. `sendMessage()` already does this for you once on `ROTATION_REQUIRED`. |
| `getChat(chatId: string): ChatInfo \| undefined` | Locally cached chat metadata (participants, roles, `chatVersion`, etc). |
| `syncChats(): void` | Fire-and-forget resync of chats/keys. Normally unnecessary — `connect()` calls this for you on every connect/reconnect. |

**Messaging — send, react, edit, delete**

| Method | Description |
|---|---|
| `sendMessage(chatId, text, opts?: { replyToMsgId? })` | Encrypts and sends a message. Auto rotate-and-resend once on `ROTATION_REQUIRED`. |
| `sendTyping(chatId, isTyping: boolean)` | Fire-and-forget typing indicator — no return value. Gateway-throttled, see [Rate limits](#rate-limits). |
| `reactToMessage(chatId, msgId, emoji: string)` | Reacts to a message with an (encrypted) emoji. |
| `removeReaction(chatId, msgId)` | Clears your own reaction on a message. |
| `editMessage(chatId, msgId, newText: string)` | Edits a text message you sent, within the contract's 15-minute edit window. Text messages only — rejected client-side for other content types. |
| `deleteMessage(chatId, msgId)` | "Delete for everyone" — same envelope as `editMessage`, with no ciphertext. Same 15-minute window. |

**Participants, roles & moderation**

| Method | Description |
|---|---|
| `addParticipant(chatId, remoteIdentity)` | Adds a participant to an existing chat — also how `JoinRequestHandle.approve()` is implemented. |
| `removeParticipant(chatId, remoteIdentity)` | Removes a participant. |
| `updateChatRoles(chatId, roles: { admins: string[], moderators: string[] })` | Replaces a group's full admin/moderator lists (not a delta) — group chats only. |
| `setChatMode(chatId, opts: { moderated: boolean })` | Toggles a group's moderated flag. |
| `reportUser(targetIdentity, reason: string)` | Flags an identity for abuse; may affect their reputation score. |

**Invites & discovery**

| Method | Description |
|---|---|
| `generateInviteLink(chatId, opts?: { expiresAt?, maxUses? })` | Creates a shareable invite code for a chat. Admin-only. |
| `revokeInviteLink(chatId)` | Invalidates a chat's current invite code. Admin-only. |
| `resolveInvite(inviteCode)` | Looks up what an invite code points to, without joining. |
| `requestJoin(inviteCode)` | Requests to join via an invite code — surfaces as a `joinRequested` event to the chat's admins/moderators. |
| `setChatDiscoverable(chatId, discoverable: boolean, category?)` | Lists/unlists a group in public discovery. Admin-only. |
| `listPublicChats(category?: string)` | Browses discoverable public groups. |

**Widgets & widget-visitor chat** — see [Widgets & visitor chat](#widgets--visitor-chat)

| Method | Description |
|---|---|
| `createWidget(name: string)` | Creates a widget. Requires Beta/Pro/Admin access ([Access tiers](#access-tiers)). |
| `deleteWidget(widgetId)` | Deletes a widget. |
| `updateWidget(widgetId, opts: { enabled? })` | Toggles a widget on/off without deleting it. |
| `listWidgets()` | Lists this identity's widgets. |
| `getWidgetInfo(widgetId)` | Public lookup — no authorization check, so it works for the embedding page itself, not just the owner. |
| `sendVisitorMessage(roomToken, text, sender?)` | Replies in an open visitor room. `sender` defaults to this identity's own profile nickname. |
| `reactToVisitorMessage(roomToken, msgId, emoji: string \| null)` | Reacts to (or, with `null`, clears a reaction on) a visitor-room message. |
| `editVisitorMessage(roomToken, msgId, text)` | Edits a message this bot sent in the room. |
| `removeVisitorMessage(roomToken, msgId)` | Removes a message this bot sent in the room. |
| `sendVisitorTyping(roomToken, isTyping: boolean)` | Fire-and-forget typing indicator for the visitor side. |
| `endVisitorRoom(roomToken)` | Permanently ends the room — the visitor is notified immediately and can't reconnect into it. |
| `getVisitorSession(roomToken)` | Local lookup of `{widgetId, visitorLabel, origin}` for a room this process is a party to. |
| `registerVisitorSession(meta: { roomToken, symKey, widgetId, visitorLabel, origin })` | Rehydrates a room this process was a party to before a restart. Call **before** `connect()`/`start()`. |

**Events** (`core.on(event, handler)`):

`connected`, `authenticated`, `disconnected`, `reconnecting` (attempt
number), `message` (`EvergramChatMessage`), `reaction` (`EvergramReaction`),
`messageEdited` (`EvergramMessageEdited`), `messageDeleted`
(`EvergramMessageDeleted`), `typing`, `delivery`, `chatKeyRotated`
(`{chatId}`), `joinRequested`, `chatRequestReceived`, `groupInviteReceived`,
`restricted` (`ReputationUpdated`), `error`, `visitorRoomRequested`
(`EvergramVisitorRoomRequested`), `visitorMessage`
(`EvergramVisitorMessage`), `visitorReaction` (`EvergramVisitorReaction`),
`visitorMessageEdited` (`EvergramVisitorMessageEdited`),
`visitorMessageDeleted` (`EvergramVisitorMessageDeleted`), `visitorTyping`
(`EvergramVisitorTyping`), `visitorStatusChanged`
(`EvergramVisitorStatusChanged`), `visitorRoomTimedOut`
(`EvergramVisitorRoomTimedOut`).

### `EvergramBot`

The ergonomic wrapper described in [Two layers](#two-layers). `bot.core`
exposes the full `EvergramCore` surface above for anything not covered here.

| Method | Description |
|---|---|
| `new EvergramBot(opts: EvergramBotOptions)` | Constructs the bot — same options as `EvergramCore`, plus optional `name`. |
| `start(): Promise<void>` | Connects and authenticates; applies `name` via `setProfile` only if it differs from the nickname `authResponse` already reports. |
| `stop(): void` | Closes the connection. |
| `onMessage(handler): () => void` | Subscribes to incoming chat messages. |
| `onReaction(handler): () => void` | Subscribes to message reactions (including removals, `emoji: null`). |
| `onMessageEdited(handler): () => void` | Subscribes to message edits. |
| `onMessageDeleted(handler): () => void` | Subscribes to message deletions ("delete for everyone"). |
| `onJoinRequest(handler): () => void` | Subscribes to join requests on chats this bot administers/moderates. `req.approve()`/`req.deny()` map to `addParticipant`/a permanent throw (no reject RPC exists — see [Known protocol limitations](#known-protocol-limitations-not-sdk-bugs)). |
| `onChatRequest(handler): () => void` | Subscribes to pending one-on-one requests (including ones already pending at connect time). `req.approve()`/`req.deny()` map to `acceptChatRequest`/`blockIdentity`. |
| `onGroupInvite(handler): () => void` | Subscribes to pending group invites (including ones already pending at connect time). `req.approve()`/`req.deny()` map to `acceptGroupInvite`/`declineGroupInvite`. |
| `reply(msg, text)` | Shorthand for `core.sendMessage(msg.chatId, text)`. |
| `onVisitorRoomRequested(handler): () => void` | Fires once per anonymous widget-visitor conversation, on their opening message. Handler receives a `VisitorSessionHandle` and the (possibly-null) decrypted first message. |
| `onVisitorMessage(handler): () => void` | Subsequent messages in an open visitor room. |
| `onVisitorReaction(handler): () => void` | Reactions in a visitor room. |
| `onVisitorMessageEdited(handler): () => void` | Edits in a visitor room. |
| `onVisitorMessageDeleted(handler): () => void` | Removals in a visitor room. |
| `onVisitorTyping(handler): () => void` | Typing indicator from the visitor side. |
| `onVisitorRoomTimedOut(handler): () => void` | The rarer race described in [Widgets & visitor chat](#widgets--visitor-chat) — an owner device was online but didn't join before the room timed out. |

Every `onVisitor*` handler above (except `onVisitorRoomTimedOut`) receives a
`VisitorSessionHandle | undefined` as its second argument —
`undefined` only if the room has already closed/expired server-side by the
time the event is processed. The handle exposes `reply`/`react`/`edit`/
`remove`/`typing`/`end`, all bound to that room's `roomToken`.

## Known protocol limitations (not SDK bugs)

- No reject/deny RPC for join requests — only `addParticipant` (approve)
  clears a `pendingJoinRequests` entry. `JoinRequestHandle.deny()` exists
  and always throws, by design, so this isn't silently swallowed.
- No request-correlation IDs on the wire — `Core` matches responses to
  requests by field type, FIFO, mirroring the webapp client's own
  `_sendAndWaitResponse`. Concurrent calls of the *same* method type share
  this limitation; different method types don't collide.
- `widgets_not_available`/`widget_limit_reached` (from `createWidget`)
  aren't narrowed into a specific `EvergramError` subclass yet — see
  [Typed errors](#typed-errors).
- Widget-visitor rooms have no contract-side persistence at all — a process
  restart loses every in-progress room unless the caller persisted
  `{roomToken, symKey, widgetId, visitorLabel, origin}` itself and replays
  it through `registerVisitorSession()`. See [Widgets & visitor chat](#widgets--visitor-chat).

## Testing

Two layers — re-run both whenever you touch the wire protocol, the auth
handshake, or `core.ts`'s request/response plumbing, instead of re-deriving
verification from scratch by hand:

```bash
npm test                 # unit — pure logic, no network, runs anywhere
npm run test:integration # needs the local stack up at ws://localhost:9000/api/ws (override with EVERGRAM_TEST_WS_URL)
npm run typecheck:test   # typechecks test/ too — `typecheck` only covers src/examples
```
