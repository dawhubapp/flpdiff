import type { FLPEvent } from "./event.ts";
import { decodeUtf16LeBytes } from "./primitives.ts";
import { type Channel, classifyChannelKind } from "../model/channel.ts";
import type { MixerInsert } from "../model/mixer-insert.ts";
import type { Pattern } from "../model/pattern.ts";

/**
 * Opcode constants for the entity-boundary events. Each is a format fact
 * cross-referenced against the dev repo's `docs/fl25-event-format.md`
 * and the clean-room spec at `ts/docs/flp-format-spec.md`; naming here is
 * our own (not borrowed from the reference parser).
 */
const OP_NEW_CHANNEL = 0x40;
const OP_CHANNEL_TYPE = 0x15;
const OP_CHANNEL_SAMPLE_PATH = 0xc4;
/** Shared name opcode. In a channel scope it's the channel name; in a
 *  mixer-slot scope it's the plugin name. Scope tracked via OP_NEW_SLOT. */
const OP_NAME = 0xcb;
/** Mixer-effect-slot boundary. Each new slot flips the walker's
 *  current-scope to "slot", ending channel attribution for subsequent
 *  0xCB events. */
const OP_NEW_SLOT = 0x62;
/** Mixer insert boundary (the insert-output event, uint32 LE). Each 0x93 closes
 *  the current insert; the total count matches FL's "active inserts"
 *  number (18 on a freshly-saved base project). */
const OP_INSERT_END = 0x93;
/** Per-insert name (UTF-16LE null-terminated). */
const OP_INSERT_NAME = 0xcc;
/**
 * Pattern identity marker (uint16 LE). FL emits this event twice
 * per pattern (once for note/controller events, once for the rest);
 * the walker dedupes by pattern id.
 */
const OP_PATTERN_NEW = 0x41;
/** Per-pattern name (UTF-16LE null-terminated). */
const OP_PATTERN_NAME = 0xc1;

/**
 * Walks the event stream and accumulates channels.
 *
 * Channel-boundary rule: opcode 0x40 (WORD, uint16 LE value) announces a
 * new channel with the carried iid. Subsequent events up to the next
 * channel-affecting event belong to that channel. Opcode 0x15 (BYTE)
 * carries the channel-type enum for the *currently active* channel.
 *
 * Everything else in the event stream is ignored at this step — pattern,
 * mixer, and arrangement extraction are separate walkers (Phase 3.3.x).
 */
export function buildChannels(events: readonly FLPEvent[]): Channel[] {
  const channels: Channel[] = [];
  let current: Channel | undefined;
  /**
   * Walker scope. Starts as "outside" (neither channel nor slot). Flips
   * to "channel" on every 0x40 and to "slot" on every 0x62. Only
   * channel-scoped events are attributed to `current`.
   */
  let scope: "outside" | "channel" | "slot" = "outside";

  for (const ev of events) {
    if (ev.opcode === OP_NEW_CHANNEL && ev.kind === "u16") {
      current = { iid: ev.value, kind: "unknown" };
      channels.push(current);
      scope = "channel";
      continue;
    }
    if (ev.opcode === OP_NEW_SLOT) {
      scope = "slot";
      continue;
    }
    if (scope !== "channel" || !current) continue;

    if (ev.opcode === OP_CHANNEL_TYPE && ev.kind === "u8") {
      current.kind = classifyChannelKind(ev.value);
      continue;
    }
    if (ev.opcode === OP_CHANNEL_SAMPLE_PATH && ev.kind === "blob") {
      current.sample_path = decodeUtf16LeBytes(ev.payload);
      continue;
    }
    if (ev.opcode === OP_NAME && ev.kind === "blob" && current.name === undefined) {
      current.name = decodeUtf16LeBytes(ev.payload);
      continue;
    }
  }

  return channels;
}

/**
 * Walks the event stream and accumulates mixer inserts.
 *
 * Insert-boundary rule: opcode 0x93 (uint32 LE) CLOSES the current
 * insert — the inverse of the channel walker's opening rule at 0x40.
 * A pending insert accumulates events (name, in this skeleton) until
 * a 0x93 fires, at which point the pending is pushed and a fresh
 * pending is opened for the next insert.
 *
 * Index 0 = master. The 18 0x93 events in an FL 25 base project
 * therefore produce inserts indexed 0..17 — matching Python's
 * `flp-info` "18 active inserts" line.
 *
 * Scope isolation: OP_INSERT_NAME (0xCC) is distinct from channel-scope
 * opcodes, so no extra scope tracking is needed. If future decode work
 * uncovers an insert opcode that shares bytes with a channel opcode,
 * the same scope pattern used for 0xCB can be extended here.
 */
export function buildMixerInserts(events: readonly FLPEvent[]): MixerInsert[] {
  const inserts: MixerInsert[] = [];
  let pending: MixerInsert = { index: 0 };

  for (const ev of events) {
    if (ev.opcode === OP_INSERT_END) {
      inserts.push(pending);
      pending = { index: inserts.length };
      continue;
    }
    if (ev.opcode === OP_INSERT_NAME && ev.kind === "blob" && pending.name === undefined) {
      pending.name = decodeUtf16LeBytes(ev.payload);
      continue;
    }
  }

  return inserts;
}

/**
 * Walks the event stream and accumulates patterns.
 *
 * Pattern-identity rule: opcode `0x41` carries the FL-assigned
 * pattern id as its uint16 value. FL emits this event **twice per
 * pattern** (once to group note/controller events, once for the
 * rest), so the walker tracks "current pattern id" and upserts a
 * single entity per distinct id.
 *
 * Name attribution: opcode `0xC1` (UTF-16LE null-terminated) applies
 * to the pattern whose id was most recently announced by a `0x41`.
 * Distinct opcode from channel/insert names, so no scope ambiguity.
 *
 * Preserves raw pattern ids (may be sparse — users can delete middle
 * patterns leaving gaps) and iteration order (first-seen).
 */
export function buildPatterns(events: readonly FLPEvent[]): Pattern[] {
  const byId = new Map<number, Pattern>();
  let currentId: number | undefined;

  for (const ev of events) {
    if (ev.opcode === OP_PATTERN_NEW && ev.kind === "u16") {
      currentId = ev.value;
      if (!byId.has(currentId)) byId.set(currentId, { id: currentId });
      continue;
    }
    if (ev.opcode === OP_PATTERN_NAME && ev.kind === "blob" && currentId !== undefined) {
      const p = byId.get(currentId);
      if (p && p.name === undefined) p.name = decodeUtf16LeBytes(ev.payload);
      continue;
    }
  }

  return [...byId.values()];
}
