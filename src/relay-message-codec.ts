import { RelayMessageKind as WireRelayMessageKind } from "./proto/evergram";

// Ported from the webapp's app/lib/relay-message-codec.ts — see
// [[evergram-sdk-relay-duplication]] memory. Keep this file's shape
// mirroring that one exactly so future protocol changes are easy to port.
export type RelayMessageKind =
  | "joined"
  | "text"
  | "left"
  | "react"
  | "edit"
  | "remove"
  | "reclaim"
  | "end"
  | "claimed_elsewhere"
  | "typing"
  | "channel_join"
  | "channel_part"
  | "channel_kicked"
  | "channel_mode";

const KIND_TO_WIRE: Record<RelayMessageKind, WireRelayMessageKind> = {
  joined: WireRelayMessageKind.RELAY_JOINED,
  text: WireRelayMessageKind.RELAY_TEXT,
  left: WireRelayMessageKind.RELAY_LEFT,
  react: WireRelayMessageKind.RELAY_REACT,
  edit: WireRelayMessageKind.RELAY_EDIT,
  remove: WireRelayMessageKind.RELAY_REMOVE,
  reclaim: WireRelayMessageKind.RELAY_RECLAIM,
  end: WireRelayMessageKind.RELAY_END,
  claimed_elsewhere: WireRelayMessageKind.RELAY_CLAIMED_ELSEWHERE,
  typing: WireRelayMessageKind.RELAY_TYPING,
  channel_join: WireRelayMessageKind.RELAY_CHANNEL_JOIN,
  channel_part: WireRelayMessageKind.RELAY_CHANNEL_PART,
  channel_kicked: WireRelayMessageKind.RELAY_CHANNEL_KICKED,
  channel_mode: WireRelayMessageKind.RELAY_CHANNEL_MODE,
};

const WIRE_TO_KIND: Partial<Record<WireRelayMessageKind, RelayMessageKind>> = {
  [WireRelayMessageKind.RELAY_JOINED]: "joined",
  [WireRelayMessageKind.RELAY_TEXT]: "text",
  [WireRelayMessageKind.RELAY_LEFT]: "left",
  [WireRelayMessageKind.RELAY_REACT]: "react",
  [WireRelayMessageKind.RELAY_EDIT]: "edit",
  [WireRelayMessageKind.RELAY_REMOVE]: "remove",
  [WireRelayMessageKind.RELAY_RECLAIM]: "reclaim",
  [WireRelayMessageKind.RELAY_END]: "end",
  [WireRelayMessageKind.RELAY_CLAIMED_ELSEWHERE]: "claimed_elsewhere",
  [WireRelayMessageKind.RELAY_TYPING]: "typing",
  [WireRelayMessageKind.RELAY_CHANNEL_JOIN]: "channel_join",
  [WireRelayMessageKind.RELAY_CHANNEL_PART]: "channel_part",
  [WireRelayMessageKind.RELAY_CHANNEL_KICKED]: "channel_kicked",
  [WireRelayMessageKind.RELAY_CHANNEL_MODE]: "channel_mode",
};

export function toWireKind(kind: RelayMessageKind): WireRelayMessageKind {
  return KIND_TO_WIRE[kind];
}

export function fromWireKind(kind: WireRelayMessageKind): RelayMessageKind | null {
  return WIRE_TO_KIND[kind] ?? null;
}

export function encodeRelayPayload(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function decodeRelayPayload(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
