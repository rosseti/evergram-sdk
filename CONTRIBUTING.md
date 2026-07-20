# Contributing

## Setup

```bash
npm install
npm run build   # compiles src/ + examples/ to dist/
```

## Before opening a PR

```bash
npm run typecheck        # src/ and examples/
npm run typecheck:test   # test/ (separate tsconfig)
npm test                 # unit — pure logic, no network, runs anywhere
```

`npm run test:integration` needs the local Evergram stack running at
`ws://localhost:9000/api/ws` (override with `EVERGRAM_TEST_WS_URL`) — not
required for most PRs, but run it if you touched the wire protocol, the auth
handshake, or `core.ts`'s request/response plumbing. CI only runs the unit
suite, since it has no access to that stack.

## Proto changes

`src/proto/evergram.proto` is a manual copy of the canonical schema in the
main Evergram webapp repo — see the comment at the top of
`test/unit/proto-sync.test.ts`. If you need a wire-format change, it has to
land there first; this repo just mirrors it. After copying the updated
`.proto` file in, regenerate the TypeScript bindings:

```bash
npm run protoc
```

Never hand-edit `src/proto/evergram.ts` — it's generated output.

## Code style

- Strict TypeScript; no `any` beyond what's already isolated in
  `typed-event-emitter.ts`.
- Don't rename existing public exports (`EvergramCore`/`EvergramBot` methods,
  event names, error classes) — this SDK is used by real bots today, and
  the point of [typed errors](README.md#typed-errors) and the typed
  `EvergramCoreEvents` (see [API reference](README.md#api-reference)) is to
  make that surface something callers can rely on.
- Don't add a new dependency for something a few lines of code can do —
  see `src/typed-event-emitter.ts` and `src/backoff.ts` for the kind of
  thing that's expected to stay dependency-free.
- Match the existing comment style: comments explain _why_ a piece of code
  exists or a constraint that isn't obvious from reading it, not _what_ it
  does line by line.

## Reporting a vulnerability

See [Security status](README.md#security-status) for the current state of
the auth path. Please don't open a public issue for a suspected
vulnerability — use GitHub's private vulnerability reporting
(repo **Security** tab → **Report a vulnerability**) instead, so a fix can
ship before details are public.
