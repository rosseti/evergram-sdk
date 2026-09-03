# Evergram SDK

[![CI](https://github.com/rosseti/evergram-sdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rosseti/evergram-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Build bots for Evergram: decentralized, end-to-end encrypted messaging,
with nothing but a Node process and an XRPL wallet key. No app to install,
no OAuth: your bot authenticates by signing a challenge with its own wallet,
then sends and receives E2EE messages (reactions, edits, deletes), manages
groups, and runs embeddable chat widgets for anonymous visitors, all
through one typed API.

> **Status: Beta.** The wallet-signature auth path this SDK depends on is
> new and is the first 100%-programmatic authentication mechanism in this
> system. See "Security status" below before relying on it for anything
> beyond local/dev use.

## Contents

- [Two layers](#two-layers)
- [Quick start](#quick-start)
- [Examples](#examples)
- [Auth flow (signed_message)](#auth-flow-signed_message)
- [Security status](#security-status)
- [Device keys & backup](#device-keys--backup)
- [How chat keys actually move](#how-chat-keys-actually-move)
- [Access tiers](#access-tiers)
- [Rate limits](#rate-limits)
- [Typed errors](#typed-errors)
- [Message content & builders](#message-content--builders)
- [Widgets & visitor chat](#widgets--visitor-chat)
- [API reference](#api-reference)
- [Known protocol limitations](#known-protocol-limitations-not-sdk-bugs)
- [Testing](#testing)

## Two layers

- **`EvergramCore`**: a 1:1, low-level mirror of the wire protocol. Every
  method maps directly to one gateway command. Use this when you need full
  control (custom protocols on top, non-chat integrations).
- **`EvergramBot`**: an ergonomic wrapper over `Core` (`bot.onMessage`,
  `bot.onJoinRequest`, `bot.reply`), in the spirit of Telegraf/Discord.js.
  Reconnection, re-authentication, key rotation, mailbox delivery, and
  rediscovering chats you were already in are all handled for you. `bot.core`
  gives you the `Core` escape hatch any time.

Both reuse the same protobuf schema and `tweetnacl` E2EE primitives the
webapp client uses; see `src/proto/evergram.proto` (copied from
`webapp/app/proto/evergram.proto`; re-run `npm run protoc` here after the
canonical schema changes) and `src/crypto.ts`.

## Quick start

```ts
import { EvergramBot, generateWallet, generateDeviceKeypair, deriveDeviceId } from "evergram-sdk";

const wallet = generateWallet(); // XRPL keypair; persist wallet.seed somewhere safe
// Signing with a regular key instead of the account's master secret? Use
// walletFromRegularKey(accountAddress, regularKeySeed) instead — it keeps
// `wallet.address` as the account being authenticated as while signing with
// the regular key's keypair.
const { pubHex, privHex } = generateDeviceKeypair();
const device = { deviceId: deriveDeviceId(pubHex), devicePubHex: pubHex, devicePrivHex: privHex };

const bot = new EvergramBot({ url: "ws://localhost:9000/api/ws", wallet, device, name: "MyBot" });
// `name` sets the bot's nickname (via setProfile) right after connecting,
// so chat UIs show "MyBot" instead of a raw rAddress. Optional: omit it
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

| Example                       | Shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `examples/echo-bot`           | The basics: identity bootstrap, listen, reply.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `examples/moderation-bot`     | Group management: auto-approving join requests by rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `examples/webhook-bridge`     | Bridging Evergram messages to an external HTTP endpoint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `examples/paywall-bot`        | Monetization: gating a managed group behind a one-time payment_request/payment_receipt exchange.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `examples/widget-visitor-bot` | Widget-visitor chat: echoes back anonymous visitor messages on an existing widget, and persists active rooms to disk so a restart can reclaim them (see `EvergramCore.registerVisitorSession`). Open the printed `/widget/{id}` URL in a browser to act as the visitor.                                                                                                                                                                                                                                                                                                                                           |
| `examples/widget-channel-bot` | Widget `public_group` channel: joins as an operator via `subscribePublicChannel`, echoes channel messages, and demonstrates moderation (`/kick`, `/ban`, `/op`, `/voice`, `/mod`, ...). Set `EVERGRAM_WIDGET_ID` to target a specific widget (falls back to the first one this identity owns).                                                                                                                                                                                                                                                                                                                    |
| `examples/trivia-bot`         | Classic IRC-style trivia game (`!trivia`, `!score`) about the XRPL/Xahau/Evernode ecosystem: in-memory per-chat rounds and scoreboard, first correct answer wins the point.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `examples/xahau-tip-bot`      | A personal, owner-only tip bot inspired by the original XRPTipBot: no custodial balance, `!tip` submits a real, immediate XAH `Payment` on Xahau straight from the bot's own wallet, targeting a replied-to message's author, an `@identityKey` mention, or a raw address. Defaults to Xahau testnet; set `TIPBOT_OWNER` and `XAHAU_WS_URL`. **Not production-hardened.** See the top-of-file comment in `index.ts` for what's still needed (secret storage, network-path test coverage, ledger reconciliation, monitoring, a human security audit) before trusting it with value that matters to anyone but you. |

Run with `npm run example:<name>`. Each example persists its generated
wallet/device to `identity.json` next to it on first run (gitignored) so
re-running doesn't orphan chat history under a new identity.

## Auth flow (signed_message)

There is no Xaman app in a headless process, so bots authenticate by signing
a per-connection challenge directly with their XRPL wallet key:

1. Right after the WebSocket opens, the gateway pushes `ServerMessage.authChallenge { nonce }`,
   a random value generated for _this connection only_, before the SDK
   sends anything. `EvergramCore.authenticate()` waits for it.
2. The SDK builds `evergram-auth:{address}:{deviceId}:{nonce}` and signs it
   with the wallet's private key (`wallet.ts#signAuthChallenge`).
3. It sends `Auth { identity, proof: { signedMessage: { publicKeyHex, signatureHex } }, device }`.
4. The gateway recomputes the same challenge from the nonce _it_ issued for this
   connection, verifies the signature against `publicKeyHex`, and confirms
   the address derived from `publicKeyHex` matches `identity.address`.
5. On a brand-new identity, the contract will reject the very first
   `authResponse` with `device_not_registered`: `EvergramCore` catches this
   automatically, calls `registerDevice`, and retries once. You don't need
   to handle this yourself (and it doesn't need a new nonce; see below).

**The nonce is single-use and connection-scoped: no cross-connection
replay.** It's generated server-side, held only in memory tied to that one
WebSocket connection, and consumed (deleted) on the first auth attempt,
success or failure. A signature captured for one connection cannot be
replayed on a different connection; the gateway only ever compares against
the nonce _it_ issued for _that_ connection, which is gone the moment it's
used (or the connection closes). Any auth failure means reconnecting for a
fresh nonce; there is deliberately no "retry without reconnecting" path.

## Security status

This auth path has been through dedicated security review, including a
follow-up pass, with no outstanding authentication-bypass vulnerability. It's
still the first fully programmatic auth path in this system (distinct from
the existing Xaman-JWT path used elsewhere), so treat it as newer and less
battle-tested than the rest, and get in touch before relying on it for
anything beyond local/dev use.

## Device keys & backup

**There is no key backup/recovery in this protocol today**, not an SDK
limitation but an inherited one (the webapp client has the exact same gap).
`device.devicePrivHex` is an X25519 key generated once
(`generateDeviceKeypair()`); every chat's symmetric key is sealed
specifically for it. Lose it, and that bot's chat history becomes
permanently unreadable: the wallet seed alone cannot recover it. Persist
both `wallet.seed` and the device keypair together, somewhere safer than
the examples' plaintext `identity.json` (a secrets manager, an encrypted
volume; your call, the SDK doesn't impose one).

## How chat keys actually move

Worth understanding before you build on this: the **gateway**, not the
contract and not any client, generates each chat's raw symmetric key and
seals it per recipient device (see `createChat.ts`/`addParticipant.ts`'s
`nacl.randomBytes(32)` + `encryptSymKeyForDevices`). It holds the plaintext
key only transiently, in memory, to seal it, never persisted or logged,
but it does see it. This is a deliberate, existing design choice in this
codebase, not something this SDK introduces or can change; mentioned here so
"end-to-end encrypted" doesn't surprise you later about exactly which hop is
trusted with what.

`EvergramCore` only ever receives the _sealed_ key
(`chat.symKeyEncrypted[yourIdentityKey].devices[yourDeviceId]`) and opens it
locally with your device's private key (`crypto.ts#openSealedSymKey`); the
SDK itself never sends a raw key anywhere. `rotateChatVersion()` asks the
gateway to mint and reseal a fresh key for a chat's current participants
on demand; `sendMessage()` also triggers this automatically (one retry) if
the contract rejects a send as `ROTATION_REQUIRED`.

Widget-visitor rooms (see "Widgets & visitor chat" below) work differently:
the symmetric key there is generated once per room and sealed only for the
widget owner's registered devices; there is no contract-side chat object,
no rotation, and no persistence, so losing every device that has the key
(or letting the process exit without `registerVisitorSession`-ing it first)
ends that conversation for good.

## Access tiers

A freshly generated wallet starts in the contract's default tier
(`"early"` in local dev), which
can create one-on-one chats but **not** groups (`group:create: false`) and
**cannot create widgets** (widgets require the `beta`/`ga`/`admin` tier or a
`pro` subscription: a freshly generated wallet gets `widgets_not_available`
from `createWidget`). `addParticipant`/`removeParticipant` on an _existing_
group only require chat-level admin/moderator role, not a tier capability,
so a bot can manage joins on a group it didn't create, as long as whoever
created it adds the bot as admin/moderator. `moderation-bot` assumes this
setup; see the comment at the top of `examples/moderation-bot/index.ts`.
Tiers that _can_ create widgets still cap how many via `access.limits.widgets`
(e.g. 5 on `beta`/`pro`); exceeding it returns `widget_limit_reached`.

## Rate limits

Most actions are rate-limited server-side, scoped per identity+device.
Exceeding a limit surfaces as `EvergramRateLimitError`; catch it and back
off rather than hammering the gateway. Contact us if your use case needs
specifics beyond that for capacity planning.

## Typed errors

`Core`/`Bot` methods reject with one of these (`src/errors.ts`) instead of
raw string codes; `err.code` still carries the original gateway/contract
code if you need it:

| Class                        | Meaning                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `EvergramAuthError`          | Auth/session rejected (bad signature, expired session, etc). `Core` retries once on its own where it safely can.                    |
| `EvergramDeviceRevokedError` | This device was revoked (see device management), terminal, not an auth hiccup. Register a new device instead of retrying.           |
| `EvergramRotationError`      | A chat's key needed to rotate and the single automatic rotate-and-resend `sendMessage()` already attempts also failed.              |
| `EvergramRateLimitError`     | Hit one of the limits above.                                                                                                        |
| `EvergramAccessDeniedError`  | Missing capability/role for this action.                                                                                            |
| `EvergramRestrictedError`    | Account flagged restricted (see `reputationUpdated`).                                                                               |
| `EvergramNotFoundError`      | Chat/device/widget/visitor-room/etc not found.                                                                                      |
| `EvergramValidationError`    | Bad input, including client-side checks (message size, participant count, malformed device key) that fail fast before a round-trip. |
| `EvergramTimeoutError`       | No response within the request timeout.                                                                                             |
| `EvergramConnectionError`    | Transport-level connect failure.                                                                                                    |

The two widget-specific codes, `widgets_not_available` (see "Access
tiers") and `widget_limit_reached`, reject as `EvergramAccessDeniedError`.

## Message content & builders

A decrypted message's `text` is either plain text or a small JSON envelope
(audio, payment request, payment receipt) discriminated by a `type` field:
`message-content.ts` is the single place that tells those apart, mirroring
`webapp/app/lib/message-content.ts` exactly so the two clients never drift
on what a given wire payload means.

```ts
import { parseMessageContent, formatMessagePreview } from "evergram-sdk";

bot.onMessage((msg) => {
  switch (msg.content.type) {
    case "text":
      console.log(msg.content.text);
      break;
    case "payment_request":
      console.log(`payment requested: ${msg.content.amount} ${msg.content.currency}`);
      break;
    // "audio", "payment_receipt": see MessageContent in src/message-content.ts
  }

  console.log(formatMessagePreview(msg.content)); // human-readable one-liner, e.g. for logs
});
```

`msg.content`/`edit.content` (`EvergramChatMessage`/`EvergramMessageEdited`)
are already parsed for you; `parseMessageContent` is exported mainly for
re-parsing `getChat()`-cached text or your own stored history.
`buildPaymentRequest`/`buildPaymentReceipt`/`buildAudioMessage` construct the
matching JSON string to pass into `sendMessage()`, instead of hand-rolling
the envelope shape yourself (see `examples/paywall-bot` for a full
request/receipt exchange).

## Widgets & visitor chat

A **widget** is a shareable, embeddable chat surface (see the webapp's
`/developers/embed` docs): anonymous visitors talk to it with no account,
wallet, or install, and never see the widget owner's real identity. From the
SDK side, the owner/bot manages widgets and the resulting conversations:

- `createWidget` / `deleteWidget` / `updateWidget` / `listWidgets` /
  `getWidgetInfo` manage the widget entities themselves (gated by access
  tier; see "Access tiers").
- When a visitor opens a widget and sends their first message, this bot
  (if one of its devices is online) receives a `visitorRoomRequested` event
  carrying an already-decrypted `firstMessage` and the room's symmetric key.
  `EvergramBot.onVisitorRoomRequested` wraps this into a `VisitorSessionHandle`
  (`reply`/`react`/`edit`/`remove`/`typing`/`end`) reused across every
  subsequent `onVisitorMessage`/`onVisitorReaction`/`onVisitorMessageEdited`/
  `onVisitorMessageDeleted`/`onVisitorTyping` callback for that same
  `roomToken`.
- These rooms are **not** contract-backed chats: no offline inbox, no
  persistence, no rotation. If this process restarts, it has no way to
  recover an in-progress room on its own; persist
  `{roomToken, symKey, widgetId, visitorLabel, origin}` yourself (from the
  `visitorRoomRequested` event) and call `core.registerVisitorSession(...)`
  with it _before_ `connect()`/`start()` on the next run; see
  `examples/widget-visitor-bot` for the full pattern, including cleanup on
  `visitorStatusChanged` reporting `"closed"`.
- `onVisitorRoomTimedOut` fires in the rarer race where an owner device was
  online when the room was created but disconnected before actually joining
  it; the common "no device online at all" case is rejected synchronously
  to the visitor and this bot never hears about it.

## API reference

Quick lookup of the full surface; see the sections above for the _why_
behind auth, encryption, access tiers, and widgets/visitor chat. This is
just _what's callable_.

### `EvergramCore`

The 1:1 protocol mirror. Every method sends one request and resolves with
the matching response (or rejects with a [typed error](#typed-errors)),
except where noted as fire-and-forget.

**Connection & profile**

| Method                                              | Description                                                                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new EvergramCore(opts: EvergramCoreOptions)`       | Constructs the client. Doesn't connect by itself; call `connect()`.                                                                                                               |
| `connect(): Promise<void>`                          | Opens the WebSocket and completes the [signed_message auth flow](#auth-flow-signed_message). Resolves once authenticated; self-heals device registration on a brand-new identity. |
| `close(): void`                                     | Closes the connection. Does not affect persisted identity/keys.                                                                                                                   |
| `registerDevice()`                                  | Registers this device for the current identity. Normally unnecessary; `connect()` does this for you on first use.                                                                 |
| `listDevices()`                                     | Lists every device registered for the current identity.                                                                                                                           |
| `revokeDevice(deviceId: string)`                    | Revokes a device. Revoking this connection's own `deviceId` invalidates the session it's currently authenticated under.                                                           |
| `setProfile(opts: { nickname?, avatarUrl?, bio? })` | Sets this identity's profile fields. No tier/capability gate.                                                                                                                     |
| `getProfile(remoteIdentity: string)`                | Reads another identity's profile (`nickname`/`avatarUrl`/`bio`).                                                                                                                  |
| `isRestricted: boolean`                             | Set from `reputationUpdated`/auth pushes; true if the contract has flagged this account restricted.                                                                               |
| `profile?: Profile`, `profileStatus?: string`       | The profile/status last reported back by `authResponse`; `profileStatus` is `"complete"` or `"missing_nickname"`.                                                                 |

**Chats: lifecycle, requests & privacy**

| Method                                                                     | Description                                                                                                                                                           |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createChat(type: "one-on-one" \| "group", participants: string[], meta?)` | Creates a chat. `participants` must include your own identity key and at least one other; groups need the `group:create` capability ([Access tiers](#access-tiers)).  |
| `acceptChatRequest(fromIdentity: string)`                                  | Accepts a pending one-on-one request, when the recipient has `requireChatApproval` on.                                                                                |
| `declineChatRequest(fromIdentity: string)`                                 | Declines one pending one-on-one request only; does not block the sender.                                                                                              |
| `acceptGroupInvite(chatId: string)`                                        | Joins a group you were invited to, under the same approval gate.                                                                                                      |
| `declineGroupInvite(chatId: string)`                                       | Declines one invite only; does not block the inviter.                                                                                                                 |
| `getPendingChatRequests(): PendingChatRequest[]`                           | Locally cached one-on-one requests awaiting your decision.                                                                                                            |
| `getPendingGroupInvites(): PendingGroupInvite[]`                           | Locally cached group invites awaiting your decision.                                                                                                                  |
| `blockIdentity(targetIdentity: string)`                                    | Blocks an identity; also clears any pending chat request from them.                                                                                                   |
| `unblockIdentity(targetIdentity: string)`                                  | Reverses `blockIdentity`.                                                                                                                                             |
| `listBlockedIdentities()`                                                  | Lists identities this account has blocked via `blockIdentity`.                                                                                                        |
| `updatePrivacySettings(requireChatApproval: boolean)`                      | Toggles whether new one-on-one chats/group invites need your explicit accept.                                                                                         |
| `leaveChat(chatId: string)`                                                | Leaves a group chat. Rejected with `leave_not_allowed` for one-on-one chats.                                                                                          |
| `rotateChatVersion(chatId: string)`                                        | Asks the gateway to mint and reseal a fresh symmetric key for the chat's current participants. `sendMessage()` already does this for you once on `ROTATION_REQUIRED`. |
| `getChat(chatId: string): ChatInfo \| undefined`                           | Locally cached chat metadata (participants, roles, `chatVersion`, etc).                                                                                               |
| `syncChats(): void`                                                        | Fire-and-forget resync of chats/keys. Normally unnecessary; `connect()` calls this for you on every connect/reconnect.                                                |

**Messaging: send, react, edit, delete**

| Method                                                | Description                                                                                                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `sendMessage(chatId, text, opts?: { replyToMsgId? })` | Encrypts and sends a message. Auto rotate-and-resend once on `ROTATION_REQUIRED`.                                                             |
| `sendTyping(chatId, isTyping: boolean)`               | Fire-and-forget typing indicator; no return value. Gateway-throttled, see [Rate limits](#rate-limits).                                        |
| `reactToMessage(chatId, msgId, emoji: string)`        | Reacts to a message with an (encrypted) emoji.                                                                                                |
| `removeReaction(chatId, msgId)`                       | Clears your own reaction on a message.                                                                                                        |
| `editMessage(chatId, msgId, newText: string)`         | Edits a text message you sent, within the contract's 15-minute edit window. Text messages only; rejected client-side for other content types. |
| `deleteMessage(chatId, msgId)`                        | "Delete for everyone", same envelope as `editMessage`, with no ciphertext. Same 15-minute window.                                             |

**Participants, roles & moderation**

| Method                                                                       | Description                                                                                    |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `addParticipant(chatId, remoteIdentity)`                                     | Adds a participant to an existing chat; also how `JoinRequestHandle.approve()` is implemented. |
| `removeParticipant(chatId, remoteIdentity)`                                  | Removes a participant.                                                                         |
| `updateChatRoles(chatId, roles: { admins: string[], moderators: string[] })` | Replaces a group's full admin/moderator lists (not a delta); group chats only.                 |
| `setChatMode(chatId, opts: { moderated: boolean })`                          | Toggles a group's moderated flag.                                                              |
| `reportUser(targetIdentity, reason: string)`                                 | Flags an identity for abuse; may affect their reputation score.                                |

**Invites & discovery**

| Method                                                          | Description                                                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `generateInviteLink(chatId, opts?: { expiresAt?, maxUses? })`   | Creates a shareable invite code for a chat. Admin-only.                                                   |
| `revokeInviteLink(chatId)`                                      | Invalidates a chat's current invite code. Admin-only.                                                     |
| `resolveInvite(inviteCode)`                                     | Looks up what an invite code points to, without joining.                                                  |
| `requestJoin(inviteCode)`                                       | Requests to join via an invite code; surfaces as a `joinRequested` event to the chat's admins/moderators. |
| `setChatDiscoverable(chatId, discoverable: boolean, category?)` | Lists/unlists a group in public discovery. Admin-only.                                                    |
| `listPublicChats(category?: string)`                            | Browses discoverable public groups.                                                                       |

**Widgets & widget-visitor chat**, see [Widgets & visitor chat](#widgets--visitor-chat)

| Method                                                                                | Description                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWidget(name: string)`                                                          | Creates a widget. Requires Beta/Pro/Admin access ([Access tiers](#access-tiers)).                                                                                    |
| `deleteWidget(widgetId)`                                                              | Deletes a widget.                                                                                                                                                    |
| `updateWidget(widgetId, opts: { enabled? })`                                          | Toggles a widget on/off without deleting it.                                                                                                                         |
| `listWidgets()`                                                                       | Lists this identity's widgets.                                                                                                                                       |
| `getWidgetInfo(widgetId)`                                                             | Public lookup, no authorization check, so it works for the embedding page itself, not just the owner.                                                                |
| `updateWidgetConfig(widgetId, config: WidgetConfig)`                                  | Sets/replaces a widget's stored config (colors, welcome copy, mode, and, for `public_group`, the channel key new visitors join with).                                |
| `subscribePublicChannel(widgetId, channelKeyHex)`                                     | Joins this bot into its own widget's `public_group` channel as an operator (auto-opped). Adopts the gateway's actual channel key if it differs from what was passed. |
| `announceChannelPresence(roomToken, sender, previousSender?)`                         | Broadcasts this operator's presence (or a nickname change) to a `public_group` channel this bot is subscribed to.                                                    |
| `moderateChannel(roomToken, action, targetParticipant?)`                              | IRC-style moderation (kick/ban/unban, grant/revoke op or voice, toggle `+m`) for a channel this bot is subscribed to. Requires op.                                   |
| `sendVisitorMessage(roomToken, text, sender?)`                                        | Replies in an open visitor room. `sender` defaults to this identity's own profile nickname.                                                                          |
| `reactToVisitorMessage(roomToken, msgId, emoji: string \| null)`                      | Reacts to (or, with `null`, clears a reaction on) a visitor-room message.                                                                                            |
| `editVisitorMessage(roomToken, msgId, text)`                                          | Edits a message this bot sent in the room.                                                                                                                           |
| `removeVisitorMessage(roomToken, msgId)`                                              | Removes a message this bot sent in the room.                                                                                                                         |
| `sendVisitorTyping(roomToken, isTyping: boolean)`                                     | Fire-and-forget typing indicator for the visitor side.                                                                                                               |
| `endVisitorRoom(roomToken)`                                                           | Permanently ends the room. The visitor is notified immediately and can't reconnect into it.                                                                          |
| `getVisitorSession(roomToken)`                                                        | Local lookup of `{widgetId, visitorLabel, origin}` for a room this process is a party to.                                                                            |
| `registerVisitorSession(meta: { roomToken, symKey, widgetId, visitorLabel, origin })` | Rehydrates a room this process was a party to before a restart. Call **before** `connect()`/`start()`.                                                               |

**Events** (`core.on(event, handler)`):

Every event name and its exact payload type is defined in one place,
[`EvergramCoreEvents`](src/core.ts), rather than duplicated here in prose,
so `core.on`/`core.emit` are type-checked against it directly (a typo like
`core.on("mesage", ...)` is a compile error) and this doc can't drift out of
sync with what the SDK actually emits. Grouped by area, for a quick sense of
what's available:

- **Connection**: `connected`, `authenticated`, `disconnected`, `reconnecting`, `error`
- **Messaging**: `message`, `reaction`, `messageEdited`, `messageDeleted`, `typing`, `delivery`
- **Chats**: `chatKeyRotated`, `chatKeyMissing`, `chatRemoved`, `joinRequested`, `joinDenied`, `chatRequestReceived`, `groupInviteReceived`, `restricted`

`chatKeyMissing` fires when this device has no sealed symmetric key for a chat, so nothing arriving in it can be decrypted. A freshly registered device is in that state for every existing chat until some participant rotates the chat key. The SDK does not rotate on its own except when a send fails, so a bot that only listens stays deaf in that chat until you call `rotateChatVersion(chatId)`:

```ts
bot.core.on("chatKeyMissing", ({ chatId }) => bot.core.rotateChatVersion(chatId));
```

Rotation is expensive for a large group (a device-key fan-out over every participant plus a consensus write), so pace this yourself if you expect many chats at once rather than firing them all in parallel.

- **Widget-visitor chat**: `visitorRoomRequested`, `visitorMessage`, `visitorReaction`, `visitorMessageEdited`, `visitorMessageDeleted`, `visitorTyping`, `visitorStatusChanged`, `visitorRoomTimedOut`, `visitorChannelParticipantJoined`, `visitorChannelParticipantLeft`, `visitorChannelModeChanged`, `visitorKicked`

### `EvergramBot`

The ergonomic wrapper described in [Two layers](#two-layers). `bot.core`
exposes the full `EvergramCore` surface above for anything not covered here.

| Method                                                   | Description                                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new EvergramBot(opts: EvergramBotOptions)`              | Constructs the bot; same options as `EvergramCore`, plus optional `name`.                                                                                                                                                                                       |
| `start(): Promise<void>`                                 | Connects and authenticates; applies `name` via `setProfile` only if it differs from the nickname `authResponse` already reports.                                                                                                                                |
| `stop(): void`                                           | Closes the connection.                                                                                                                                                                                                                                          |
| `onMessage(handler): () => void`                         | Subscribes to incoming chat messages.                                                                                                                                                                                                                           |
| `onReaction(handler): () => void`                        | Subscribes to message reactions (including removals, `emoji: null`).                                                                                                                                                                                            |
| `onMessageEdited(handler): () => void`                   | Subscribes to message edits.                                                                                                                                                                                                                                    |
| `onMessageDeleted(handler): () => void`                  | Subscribes to message deletions ("delete for everyone").                                                                                                                                                                                                        |
| `onJoinRequest(handler): () => void`                     | Subscribes to join requests on chats this bot administers/moderates. `req.approve()`/`req.deny()` map to `addParticipant`/`denyJoinRequest`.                                                                                                                    |
| `onChatRequest(handler): () => void`                     | Subscribes to pending one-on-one requests (including ones already pending at connect time). `req.approve()`/`req.deny()` map to `acceptChatRequest`/`declineChatRequest` — `deny()` does not block the sender; call `core.blockIdentity()` separately for that. |
| `onGroupInvite(handler): () => void`                     | Subscribes to pending group invites (including ones already pending at connect time). `req.approve()`/`req.deny()` map to `acceptGroupInvite`/`declineGroupInvite`.                                                                                             |
| `reply(msg, text)`                                       | Shorthand for `core.sendMessage(msg.chatId, text)`.                                                                                                                                                                                                             |
| `replyWithTyping(msg, text)`                             | Same as `reply()`, but toggles the "typing…" indicator first for a duration scaled to `text`'s length, so the bot reads as composing a response. Only meant for use inside an `onX` handler — see `sendTypedMessage`/`trySendTyping` for other contexts.        |
| `sendTypedMessage(chatId, text)`                         | The `chatId`-keyed primitive `replyWithTyping()` is built on, for callers without a live message to reply to (e.g. a timer-driven reminder).                                                                                                                    |
| `trySendTyping(chatId, isTyping)`                        | Swallow-and-emit wrapper around `core.sendTyping()` — for callers that need to interleave the indicator with their own cancellable timers instead of going through `sendTypedMessage`.                                                                          |
| `onVisitorRoomRequested(handler): () => void`            | Fires once per anonymous widget-visitor conversation, on their opening message. Handler receives a `VisitorSessionHandle` and the (possibly-null) decrypted first message.                                                                                      |
| `onVisitorMessage(handler): () => void`                  | Subsequent messages in an open visitor room.                                                                                                                                                                                                                    |
| `onVisitorReaction(handler): () => void`                 | Reactions in a visitor room.                                                                                                                                                                                                                                    |
| `onVisitorMessageEdited(handler): () => void`            | Edits in a visitor room.                                                                                                                                                                                                                                        |
| `onVisitorMessageDeleted(handler): () => void`           | Removals in a visitor room.                                                                                                                                                                                                                                     |
| `onVisitorTyping(handler): () => void`                   | Typing indicator from the visitor side.                                                                                                                                                                                                                         |
| `onVisitorRoomTimedOut(handler): () => void`             | The rarer race described in [Widgets & visitor chat](#widgets--visitor-chat): an owner device was online but didn't join before the room timed out.                                                                                                             |
| `onVisitorChannelParticipantJoined(handler): () => void` | `public_group` only: another participant announces itself (fresh join or rename).                                                                                                                                                                               |
| `onVisitorChannelParticipantLeft(handler): () => void`   | `public_group` only: a channel participant disconnects.                                                                                                                                                                                                         |
| `onVisitorChannelModeChanged(handler): () => void`       | `public_group` only: a `moderateChannel()` action (by this bot or another op) changed the moderated flag or op/voice roster.                                                                                                                                    |
| `onVisitorKicked(handler): () => void`                   | `public_group` only: this bot's own channel subscription was kicked or banned; no `VisitorSessionHandle` is passed, the session is already torn down.                                                                                                           |

Every `onVisitor*` handler above (except `onVisitorRoomTimedOut`) receives a
`VisitorSessionHandle | undefined` as its second argument:
`undefined` only if the room has already closed/expired server-side by the
time the event is processed. The handle exposes `reply`/`replyWithTyping`/
`react`/`edit`/`remove`/`typing`/`end`, all bound to that room's `roomToken`.

## Known protocol limitations (not SDK bugs)

- Widget-visitor rooms have no contract-side persistence at all: a process
  restart loses every in-progress room unless the caller persisted
  `{roomToken, symKey, widgetId, visitorLabel, origin}` itself and replays
  it through `registerVisitorSession()`. See [Widgets & visitor chat](#widgets--visitor-chat).

## Testing

Two layers; re-run both whenever you touch the wire protocol, the auth
handshake, or `core.ts`'s request/response plumbing, instead of re-deriving
verification from scratch by hand:

```bash
npm test                 # unit: pure logic, no network, runs anywhere
npm run test:integration # needs the local stack up at ws://localhost:9000/api/ws (override with EVERGRAM_TEST_WS_URL)
npm run typecheck:test   # typechecks test/ too; `typecheck` only covers src/examples
```
