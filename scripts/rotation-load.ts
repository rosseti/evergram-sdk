// Local load rig for the EAGER_ROTATE_LIMIT question (see
// app/lib/process-chat.ts). It answers ONE of the two numbers the cap is
// blocked on: what a burst of K concurrent rotateChatVersion calls costs
// when the chats are real M-participant groups on a real local HotPocket
// node. The other number — how many chats a real account actually boots
// with in keys-missing — is a property of production accounts and cannot be
// measured here, because here we choose it.
//
// Run against a LOCAL node only — it authenticates with throwaway unfunded
// wallets, which only works because meetsMinimumBalance() short-circuits
// whenever NODE_ENV !== "production". Start the gateway with the queue
// trace on:
//
//   EVERGRAM_QUEUE_TRACE=1 npm --prefix webapp run server
//
// Then, from sdk/:
//   MEMBERS=100 CHATS=8 SWEEP=1,2,4,8 npx tsx scripts/rotation-load.ts
//
// Add INVITE=<addr>,<addr> to also pull real wallets into every group, so
// the result is inspectable in a normal client.
//
// Read this script's own per-call latencies together with the gateway's
// [QTRACE] lines (waitMs vs execMs vs queuedBehind) — the split between
// "waiting for a write slot" and "waiting for consensus" is the whole point.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ChainFamily,
  EvergramCore,
  EvergramDevice,
  EvergramWallet,
  deriveDeviceId,
  identityKey,
  generateDeviceKeypair,
  generateWallet,
  walletFromSeed,
} from "../src/index.js";

const GATEWAY_URL = process.env.EVERGRAM_GATEWAY_URL || "ws://localhost:9000/api/ws";
// Participants per group, the victim included. Drives the per-rotation
// device-key fan-out, which is the part of rotation cost that scales.
const MEMBERS = Number(process.env.MEMBERS || 25);
// How many groups the victim belongs to. Must be >= max(SWEEP): each sweep
// point rotates a disjoint slice so no chat is measured twice.
const CHATS = Number(process.env.CHATS || 8);
const SWEEP = (process.env.SWEEP || "1,2,4,8").split(",").map((s) => Number(s.trim()));
// Connect fan-in for phase 1. Every filler needs a registered device before
// createChat can seal the group key for it, and registerDevice is a WRITE:
// it lands on hpWriteQueue (concurrency 4, ~10-12s round trip locally)
// while the SDK holds a hardcoded 35s client-side deadline for the
// response. Anything above 4 in flight means tasks start their clock in the
// queue and burn most of that budget waiting for a slot — at 8 the tail
// reliably blows the deadline. 3 keeps the queue drained with headroom, at
// the cost of phase 1 taking roughly MEMBERS/3 * RTT.
const CONNECT_CONCURRENCY = Number(process.env.CONNECT_CONCURRENCY || 3);
const CONNECT_ATTEMPTS = Number(process.env.CONNECT_ATTEMPTS || 3);
// Quiet-node probe sends taken before each sweep point. The gateway allows
// 5 messages per 10s per identity+device, and each probe waits for its own
// delivery (~1 round trip), so this stays far under the limit.
const PROBE_BASELINE = Number(process.env.PROBE_BASELINE || 3);
const PROBE_INTERVAL_MS = Number(process.env.PROBE_INTERVAL_MS || 500);
const PROBE_MAX_SAMPLES = Number(process.env.PROBE_MAX_SAMPLES || 60);

// DRAIN=1 replaces the burst sweep with a sustained drain: the shape the
// paced-queue proposal actually produces. A burst measures one instant; the
// question a paced queue raises is whether HALF AN HOUR of steady rotation
// degrades anything, and whether several devices draining at once (every
// member of a large group goes keys-missing after one rotation) compounds.
const DRAIN = process.env.DRAIN === "1";
const DRAIN_ROTATIONS = Number(process.env.DRAIN_ROTATIONS || 40);
const DRAIN_CONCURRENCY = Number(process.env.DRAIN_CONCURRENCY || 2);
// Independent drainers, each running its own concurrency-limited queue over
// the same pool of chats. >1 reproduces the compounding case, including the
// rotation_conflict races between devices that is part of its real cost.
const DRAIN_DEVICES = Number(process.env.DRAIN_DEVICES || 1);
// Probe samples are grouped into buckets so drift over the drain is visible
// as a series rather than averaged away into one number.
const PROBE_BUCKET_MS = Number(process.env.PROBE_BUCKET_MS || 30_000);
const STATE_PATH = process.env.STATE_PATH || join(__dirname, ".rotation-load-identities.json");
// Optional: real wallet addresses (comma-separated, bare addresses — the
// script qualifies them) to invite into every group, so the rig's chats are
// visible in a normal client instead of only existing between throwaway
// bots. Each one must already have a registered device on this node — log
// in with it once first, or addParticipant fails with
// identity_has_no_devices and the group would be left unrotatable.
const INVITE = (process.env.INVITE || "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);

interface StoredWallet {
  walletSeed: string;
  devicePubHex: string;
  devicePrivHex: string;
}

interface RigState {
  fillers: StoredWallet[];
  victim: StoredWallet;
  // Chat ids from previous runs. Creating a 100-participant group costs a
  // full consensus round trip each, so re-creating them on every run turns
  // a 30s measurement into a 5-minute one — and a failure anywhere after
  // phase 2 used to throw all of that away. Reused chats are warm rather
  // than freshly created, which the collateral probe does not care about.
  chats?: string[];
  probeChatId?: string;
  // Bots only authenticate; nothing gives them a profile. Without one,
  // getProfile answers profile_not_found, which is a shorter path through
  // the contract than the real read the probe is meant to imitate.
  probeProfileSet?: boolean;
}

function makeIdentity(): StoredWallet {
  const wallet = generateWallet();
  const { pubHex, privHex } = generateDeviceKeypair();
  return { walletSeed: wallet.seed, devicePubHex: pubHex, devicePrivHex: privHex };
}

function hydrate(stored: StoredWallet): { wallet: EvergramWallet; device: EvergramDevice } {
  return {
    wallet: walletFromSeed(stored.walletSeed),
    device: {
      deviceId: deriveDeviceId(stored.devicePubHex),
      devicePubHex: stored.devicePubHex,
      devicePrivHex: stored.devicePrivHex,
    },
  };
}

// Identities are reused across runs: registering MEMBERS devices is by far
// the slowest phase, and it is pure setup — nothing about it is what we are
// trying to measure.
function loadOrCreateState(): RigState {
  if (existsSync(STATE_PATH)) {
    const state: RigState = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (state.fillers.length >= MEMBERS - 1) return state;
    console.log(`[rig] growing filler pool ${state.fillers.length} -> ${MEMBERS - 1}`);
    while (state.fillers.length < MEMBERS - 1) state.fillers.push(makeIdentity());
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    return state;
  }

  const state: RigState = {
    fillers: Array.from({ length: MEMBERS - 1 }, makeIdentity),
    victim: makeIdentity(),
  };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`[rig] created ${state.fillers.length + 1} throwaway identities at ${STATE_PATH}`);
  return state;
}

// Failures are collected, not thrown: one filler timing out must not
// discard the setup work already done for the other 98. Phase 2 then builds
// the group from whoever actually registered — a participant with no device
// makes the group permanently unrotatable (encryptSymKeyForDevices throws
// identity_has_no_devices), so a half-registered filler must be left out
// entirely rather than carried into createChat.
async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<{ ok: R[]; failed: { index: number; error: string }[] }> {
  const ok: R[] = [];
  const failed: { index: number; error: string }[] = [];
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = cursor++; i < items.length; i = cursor++) {
        let lastError = "";

        for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
          try {
            ok.push(await fn(items[i], i));
            lastError = "";
            break;
          } catch (err) {
            lastError = (err as Error).message;
            // The gateway retries the underlying write on its own backoff;
            // piling a fresh attempt on top of a still-draining queue just
            // makes it worse. Wait out roughly one round trip first.
            await new Promise((r) => setTimeout(r, 12_000 * (attempt + 1)));
          }
        }

        if (lastError) failed.push({ index: i, error: lastError });
      }
    }),
  );

  return { ok, failed };
}

// A send is NOT round-tripped by sendMessage(): it resolves as soon as the
// envelope is handed to the gateway, and the actual outcome arrives later
// as a "delivery" event. Awaiting the call would therefore measure almost
// nothing. This waits for the delivery of that specific msgId, which is the
// latency a real user actually feels.
// The probe deliberately does NOT send a message. sendMessage() never
// reaches HotPocket — the gateway acks it locally and fans out over
// WebSocket/mailbox — so message latency is blind to rotation load by
// construction, and hammering it only trips the 5-per-10s send limiter.
// Rotation's collateral surface is the READ queue: every rotation does a
// getChat plus a getDevicePublicKeysByIdentities fan-out on the same
// hpReadQueue that serves real user reads. getProfile is such a read, and
// is exactly the kind of thing a user waits on while staring at a spinner.
async function probeRead(core: EvergramCore, targetIdKey: string): Promise<number> {
  const started = Date.now();
  try {
    await core.getProfile(targetIdKey);
  } catch {
    // A failed read still travelled the read queue, which is the thing being
    // timed. Swallowing it keeps one transient error from ending a sweep
    // that has minutes of setup behind it.
  }
  return Date.now() - started;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return -1;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// The sustained-load counterpart to the burst sweep. Rotations are paced
// exactly the way the proposed eager queue would pace them (a fixed number
// in flight per device, refilled as each finishes) and the read probe runs
// for the whole duration, so the output is a time series: if a long drain
// degrades unrelated reads, the later buckets show it.
async function runDrain(
  chatIds: string[],
  probeTarget: string,
  probeCore: EvergramCore,
  drainers: EvergramCore[],
): Promise<void> {
  const devices = drainers.slice(0, DRAIN_DEVICES);
  const perDevice = Math.ceil(DRAIN_ROTATIONS / devices.length);

  console.log(
    `[rig] phase 5: draining ${DRAIN_ROTATIONS} rotations across ${devices.length} device(s), ` +
      `${DRAIN_CONCURRENCY} in flight each`,
  );

  // Quiet-node baseline first: the buckets below are only meaningful
  // against a number taken while nothing is rotating.
  const baseline: number[] = [];
  for (let i = 0; i < PROBE_BASELINE; i++) {
    baseline.push(await probeRead(probeCore, probeTarget));
  }
  const baselineSorted = [...baseline].sort((a, b) => a - b);
  console.log(`[rig] probe baseline p50 ${percentile(baselineSorted, 50)}ms`);

  const startedAt = Date.now();
  let drainDone = false;
  const rotations: { ms: number; ok: boolean; err?: string }[] = [];

  const runDevice = async (core: EvergramCore, deviceIndex: number) => {
    let issued = 0;

    const worker = async () => {
      while (issued < perDevice) {
        // Captured before the await so two workers on the same device never
        // take the same slot.
        const seq = issued++;
        // Offset per device so devices do not march in lockstep over the
        // same chat, which would turn the whole drain into a conflict storm
        // rather than the mix of contention and conflict a real boot has.
        const chatId = chatIds[(seq + deviceIndex) % chatIds.length];
        const callStarted = Date.now();

        try {
          await core.rotateChatVersion(chatId);
          rotations.push({ ms: Date.now() - callStarted, ok: true });
        } catch (err) {
          rotations.push({ ms: Date.now() - callStarted, ok: false, err: (err as Error).message });
        }
      }
    };

    await Promise.all(Array.from({ length: DRAIN_CONCURRENCY }, worker));
  };

  const drain = Promise.all(devices.map(runDevice)).then(() => {
    drainDone = true;
  });

  const samples: { at: number; ms: number }[] = [];

  const probe = (async () => {
    while (!drainDone) {
      const at = Date.now() - startedAt;
      samples.push({ at, ms: await probeRead(probeCore, probeTarget) });
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
    }
  })();

  await Promise.all([drain, probe]);

  const elapsed = Date.now() - startedAt;
  const failures = rotations.filter((r) => !r.ok);
  const rotationMs = rotations.map((r) => r.ms).sort((a, b) => a - b);

  console.log(
    `[rig] drain finished in ${(elapsed / 1000).toFixed(0)}s: ${rotations.length} rotations, ` +
      `${failures.length} failed (${failures[0]?.err ?? "none"})`,
  );
  console.log(
    `[rig] rotation p50 ${percentile(rotationMs, 50)}ms p95 ${percentile(rotationMs, 95)}ms`,
  );

  // Bucketed rather than pooled: a drift that only appears after ten minutes
  // is invisible in a single percentile over the whole run.
  const buckets = new Map<number, number[]>();
  for (const sample of samples) {
    const bucket = Math.floor(sample.at / PROBE_BUCKET_MS);
    const list = buckets.get(bucket);
    if (list) list.push(sample.ms);
    else buckets.set(bucket, [sample.ms]);
  }

  console.log(`[rig] probe by ${PROBE_BUCKET_MS / 1000}s bucket:`);
  for (const [bucket, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...list].sort((a, b) => a - b);
    console.log(
      `[rig]   t+${bucket * (PROBE_BUCKET_MS / 1000)}s  n=${sorted.length}  ` +
        `p50=${percentile(sorted, 50)}ms  p95=${percentile(sorted, 95)}ms  max=${sorted[sorted.length - 1]}ms`,
    );
  }
}

async function main() {
  if (CHATS < Math.max(...SWEEP)) {
    throw new Error(`CHATS (${CHATS}) must be >= the largest SWEEP point (${Math.max(...SWEEP)})`);
  }

  // Fully disjoint slices need one chat per rotation across the WHOLE
  // sweep, not just per point. Below that the later points re-rotate a chat
  // an earlier point already touched — still a valid burst, but a warm one,
  // so the numbers stop being comparable across the curve.
  const sweepTotal = SWEEP.reduce((a, b) => a + b, 0);
  if (CHATS < sweepTotal) {
    console.warn(
      `[rig] CHATS (${CHATS}) < total rotations in sweep (${sweepTotal}) — ` +
        `later points will re-rotate already-rotated chats. Use CHATS=${sweepTotal} for a clean curve.`,
    );
  }

  const state = loadOrCreateState();
  const fillers = state.fillers.slice(0, MEMBERS - 1);

  console.log(`[rig] phase 1: connecting ${fillers.length} fillers + victim to ${GATEWAY_URL}`);
  const t0 = Date.now();

  let done = 0;
  const { ok: live, failed } = await pooled(fillers, CONNECT_CONCURRENCY, async (stored, i) => {
    const { wallet, device } = hydrate(stored);
    const core = new EvergramCore({ url: GATEWAY_URL, wallet, device });
    const started = Date.now();
    // connect() runs the signed_message flow, which self-heals a missing
    // device registration — no explicit registerDevice() needed.
    await core.connect();
    done++;
    if (done % 10 === 0) {
      console.log(
        `[rig]   ${done}/${fillers.length} connected (last ${Date.now() - started}ms, ` +
          `${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`,
      );
    }
    // Participants are identity KEYS ("<chainFamily>:<address>"), not bare
    // addresses — the contract's userRoot()/identityKey() rejects an
    // unqualified address outright (invalid_identity), and this string is
    // the map key used for participants and symKeyEncrypted everywhere
    // server-side.
    return {
      core,
      address: wallet.address,
      idKey: identityKey({ chainFamily: ChainFamily.XRPL, address: wallet.address } as any),
      index: i,
    };
  });

  // pooled() collects in completion order, which varies run to run. Restore
  // index order so live[0] — the creator, and therefore the address that
  // has to be granted group:create — is the same wallet on every run.
  live.sort((a, b) => a.index - b.index);

  if (failed.length) {
    console.warn(`[rig] ${failed.length} filler(s) never registered: ${failed[0].error}`);
    console.warn(`[rig] continuing with ${live.length} — re-run to pick the rest up, already-`);
    console.warn(`[rig] registered identities skip registerDevice and reconnect cheaply.`);
  }

  const victimId = hydrate(state.victim);
  const victim = new EvergramCore({
    url: GATEWAY_URL,
    wallet: victimId.wallet,
    device: victimId.device,
  });
  await victim.connect();

  console.log(`[rig] phase 1 done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // The creator is a filler, not the victim: createChat's own rate limit is
  // per identity+device, and the victim is the identity we care about
  // keeping unthrottled for the measured rotations.
  const creator = live[0].core;
  const participants = [
    ...live.map((l) => l.idKey),
    identityKey({ chainFamily: ChainFamily.XRPL, address: victimId.wallet.address } as any),
  ];

  // The contract gates group creation on the `group:create` capability, and
  // access.config.json's defaultTier ("early") does NOT have it — a
  // throwaway wallet gets capability_not_allowed. Cheapest local unblock is
  // making the creator the admin account (tier admin, "*": true):
  // EVERGRAM_ADMIN_ACCOUNT is on inject-contract-env.sh's whitelist, so it
  // only needs a container restart, not a contract rebuild.
  console.log(`[rig] creator address (EVERGRAM_ADMIN_ACCOUNT): ${live[0].address}`);
  let chatIds: string[] = (state.chats ?? []).slice(0, CHATS);

  // Recovery for groups created by a run that died before chat persistence
  // existed: the creator is a participant, so syncChats() repopulates them
  // on connect and they can be matched by the name this rig gives them.
  // Reaching into the private `chats` map is a rig-only escape hatch — the
  // SDK has no public accessor and adding one is not this script's call.
  if (chatIds.length < CHATS) {
    const seen = new Set(chatIds);
    const recovered: string[] = [];

    // connect() kicks off syncChats() without awaiting it, so the map is
    // empty for a beat after auth.
    for (let waited = 0; waited < 30_000 && !recovered.length; waited += 500) {
      for (const [chatId, chat] of (creator as any).chats as Map<string, any>) {
        const name = chat?.meta?.name ?? "";
        if (!name.startsWith("rotation-load-") || name.startsWith("rotation-load-probe")) continue;
        if (seen.has(chatId)) continue;
        recovered.push(chatId);
      }
      if (!recovered.length) await new Promise((r) => setTimeout(r, 500));
    }

    if (recovered.length) {
      chatIds = [...chatIds, ...recovered].slice(0, CHATS);
      state.chats = chatIds;
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
      console.log(`[rig] recovered ${recovered.length} group(s) from an earlier run`);
    }
  }

  if (chatIds.length >= CHATS) {
    console.log(`[rig] phase 2: reusing ${chatIds.length} groups from a previous run`);
  } else {
    console.log(
      `[rig] phase 2: creating ${CHATS - chatIds.length} groups of ${participants.length} participants`,
    );
  }

  for (let i = chatIds.length; i < CHATS; i++) {
    const started = Date.now();
    const resp = await creator.createChat("group", participants, {
      name: `rotation-load-${Date.now()}-${i}`,
    });
    const chatId = resp?.chat?.chatId;
    if (!chatId)
      throw new Error(`createChat ${i} returned no chat: ${JSON.stringify(resp?.status)}`);
    chatIds.push(chatId);
    // Persisted per chat, not after the loop: a failure partway through
    // used to discard every group already created.
    state.chats = chatIds;
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log(`[rig]   chat ${i + 1}/${CHATS} created in ${Date.now() - started}ms`);
  }

  if (live.length < 2) throw new Error("need at least 2 registered fillers for the probe chat");

  // The collateral probe. This is the measurement the cap actually turns
  // on: not what a rotation burst costs the device firing it, but what it
  // costs an UNRELATED user sending a message at the same time. Kept
  // deliberately tiny (2 participants) so any latency it shows comes from
  // contention with the burst rather than from its own fan-out.
  // Both identities listed explicitly: the contract counts the array it is
  // given and rejects anything under 2 (no_participants) — the caller is
  // not added implicitly.
  const probeResp = state.probeChatId
    ? { chat: { chatId: state.probeChatId } }
    : await creator.createChat("group", [live[0].idKey, live[1].idKey], {
        name: `rotation-load-probe-${Date.now()}`,
      });
  const probeChatId = probeResp?.chat?.chatId;
  if (!probeChatId) {
    throw new Error(`probe chat not created: ${JSON.stringify((probeResp as any)?.status)}`);
  }
  state.probeChatId = probeChatId;
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`[rig] probe chat ${probeChatId} (2 participants)`);

  // A filler that takes no part in the burst, so the probe read is never
  // waiting on the same identity the rotations are touching.
  const probeEntry = live[2] ?? live[1];
  const probeTarget = probeEntry.idKey;

  if (!state.probeProfileSet) {
    await probeEntry.core.setProfile({ nickname: "rotation-load-probe-target" });
    state.probeProfileSet = true;
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log(`[rig] probe target profile set (${probeTarget})`);
  }

  if (INVITE.length) {
    console.log(`[rig] phase 3: inviting ${INVITE.length} wallet(s) into ${chatIds.length} groups`);

    // Sequential, and before the sweep rather than during it: each
    // addParticipant carries its own bundled rotateChatVersion (the new
    // member's key has to be sealed), so running these in parallel with the
    // measured rotations would put unrelated writes on the same queue and
    // corrupt the numbers phase 4 is trying to read.
    for (const chatId of chatIds) {
      for (const address of INVITE) {
        const idKey = identityKey({ chainFamily: ChainFamily.XRPL, address } as any);
        const started = Date.now();
        try {
          await creator.addParticipant(chatId, idKey);
          console.log(`[rig]   ${address} -> ${chatId} in ${Date.now() - started}ms`);
        } catch (err) {
          // Non-fatal: a wallet that never logged into this node has no
          // device, and losing it costs nothing but visibility. The chats
          // between the bots are still perfectly measurable.
          console.warn(`[rig]   ${address} -> ${chatId} FAILED: ${(err as Error).message}`);
        }
      }
    }
  }

  if (DRAIN) {
    await runDrain(chatIds, probeTarget, creator, [victim, ...live.slice(3).map((l) => l.core)]);

    victim.close();
    for (const l of live) l.core.close();
    return;
  }

  console.log(`[rig] phase 4: sweeping concurrency ${SWEEP.join(",")}`);
  const report: Record<string, unknown>[] = [];
  let offset = 0;

  for (const k of SWEEP) {
    // Modular, not chatIds.slice(offset, offset + k): a plain slice near the
    // end of the array silently returns FEWER than k chats, so the sweep
    // point quietly measures a smaller burst than it reports.
    const slice = Array.from({ length: k }, (_, j) => chatIds[(offset + j) % chatIds.length]);
    offset = (offset + k) % chatIds.length;

    // Baseline first, on a quiet node, so each sweep point is compared
    // against its own contemporaneous baseline rather than a single one
    // taken at the start (the node is not in the same state minutes later).
    const baseline: number[] = [];
    for (let i = 0; i < PROBE_BASELINE; i++) {
      baseline.push(await probeRead(creator, probeTarget));
    }

    const started = Date.now();
    let burstDone = false;

    const burst = Promise.all(
      // Deduped: with k > CHATS the modular walk repeats a chatId, and two
      // concurrent rotations of the SAME chat race each other into
      // rotation_conflict rather than measuring queue behaviour.
      [...new Set(slice)].map(async (chatId) => {
        const callStarted = Date.now();
        try {
          await victim.rotateChatVersion(chatId);
          return { ms: Date.now() - callStarted, ok: true };
        } catch (err) {
          return { ms: Date.now() - callStarted, ok: false, err: (err as Error).message };
        }
      }),
    ).then((res) => {
      burstDone = true;
      return res;
    });

    // Probe continuously for as long as the burst is in flight. Sequential,
    // one message at a time: a real user sends one message and waits, and
    // piling up concurrent probes would make the probe part of the load it
    // is supposed to be observing.
    const during: number[] = [];
    while (!burstDone && during.length < PROBE_MAX_SAMPLES) {
      try {
        during.push(await probeRead(creator, probeTarget));
      } catch (err) {
        console.warn(`[rig]   probe failed during k=${k}: ${(err as Error).message}`);
        break;
      }
      // A read that resolves from a gateway-side cache returns in
      // milliseconds, which would otherwise spin this loop thousands of
      // times per burst and turn the probe itself into the load.
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
    }

    const outcomes = await burst;

    const latencies = outcomes.map((o) => o.ms).sort((a, b) => a - b);
    const failures = outcomes.filter((o) => !o.ok);
    const row = {
      concurrency: k,
      rotated: outcomes.length,
      members: participants.length,
      wallClockMs: Date.now() - started,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      maxMs: latencies[latencies.length - 1],
      failed: failures.length,
      firstError: failures[0]?.err,
      probeBaselineP50Ms: percentile(
        [...baseline].sort((a, b) => a - b),
        50,
      ),
      probeDuringP50Ms: percentile(
        [...during].sort((a, b) => a - b),
        50,
      ),
      probeDuringMaxMs: during.length ? Math.max(...during) : -1,
      probeSamples: during.length,
    };
    report.push(row);
    console.log(`[rig] ${JSON.stringify(row)}`);
  }

  console.log(`[rig] summary\n${JSON.stringify(report, null, 2)}`);

  victim.close();
  for (const l of live) l.core.close();
}

main().catch((err) => {
  console.error("[rig] failed:", err);
  process.exit(1);
});
