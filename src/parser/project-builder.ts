import type { FLPEvent } from "./event.ts";
import { decodeUtf16LeBytes } from "./primitives.ts";
import { decodeVSTWrapper } from "./vst-wrapper.ts";
import { type Channel, classifyChannelKind, unpackRGBA, decodeLevels } from "../model/channel.ts";
// unpackRGBA is re-used for pattern color (0x96) — same byte packing as 0x80.
import type { MixerInsert, MixerSlot } from "../model/mixer-insert.ts";
import { type Pattern, decodeNotes } from "../model/pattern.ts";
import { type Arrangement, decodeClips } from "../model/arrangement.ts";

/**
 * Opcode constants for the entity-boundary events. Each is a format fact
 * cross-referenced against the dev repo's `docs/fl25-event-format.md`
 * and the clean-room spec at `ts/docs/flp-format-spec.md`; naming here is
 * our own (not borrowed from the reference parser).
 */
const OP_NEW_CHANNEL = 0x40;
const OP_CHANNEL_TYPE = 0x15;
const OP_CHANNEL_SAMPLE_PATH = 0xc4;
/** Plugin internal-class name (UTF-16LE). On a bare sampler channel
 *  FL emits this as an empty string. */
const OP_PLUGIN_INTERNAL_NAME = 0xc9;
/**
 * Plugin color (uint32 LE). FL packs RGBA bytes in order [R, G, B, A]
 * — reading as uint32 LE gives `value & 0xFF = R`,
 * `(value >> 8) & 0xFF = G`, etc. Shared between channels and mixer
 * slots; scope gating (before first 0x62) keeps channel attribution
 * clean.
 */
const OP_PLUGIN_COLOR = 0x80;
/**
 * Channel levels struct. 24-byte blob with 6 × int32 fields: pan,
 * volume, pitch_shift, filter_mod_x, filter_mod_y, filter_type.
 */
const OP_CHANNEL_LEVELS = 0xdb;
/**
 * Plugin state blob. For VST-wrapped plugins
 * (`internalName === "Fruity Wrapper"`) the payload is the FL
 * VST-wrapper's id-length-value record stream containing the VST's
 * display name, vendor, path, etc. — decoded via `decodeVSTWrapper`.
 * For native plugins it's plugin-specific state (opaque to us for now).
 */
const OP_PLUGIN_STATE = 0xd5;
/** Shared name opcode. In a channel scope it's the channel name; in a
 *  mixer-slot scope it's the plugin name. Scope tracked via OP_NEW_SLOT. */
const OP_NAME = 0xcb;
/** Mixer-effect-slot boundary. Each new slot flips the walker's
 *  current-scope to "slot", ending channel attribution for subsequent
 *  0xCB events. */
const OP_NEW_SLOT = 0x62;
/** Mixer insert boundary (uint32 LE). Each 0x93 closes the current
 *  insert; the total count matches FL's "active inserts" number
 *  (18 on a freshly-saved base project). The event's VALUE is the
 *  insert's output-routing target (int32; -1 = default). */
const OP_INSERT_END = 0x93;
/** Per-insert name (UTF-16LE null-terminated). */
const OP_INSERT_NAME = 0xcc;
/** Insert color (uint32 LE RGBA-packed). */
const OP_INSERT_COLOR = 0x95;
/** Insert icon id (int16 LE). */
const OP_INSERT_ICON = 0x5f;
/** Insert audio input source (int32 LE, -1 sentinel). */
const OP_INSERT_INPUT = 0x9a;
/** Int32 value indicating "no explicit routing" — stored as 0xFFFFFFFF (-1 signed). */
const ROUTING_UNSET = 0xffffffff;
/**
 * Pattern identity marker (uint16 LE). FL emits this event twice
 * per pattern (once for note/controller events, once for the rest);
 * the walker dedupes by pattern id.
 */
const OP_PATTERN_NEW = 0x41;
/** Per-pattern name (UTF-16LE null-terminated). */
const OP_PATTERN_NAME = 0xc1;
/**
 * Per-pattern note list. FL 25 emits notes at `0xE0`; pre-FL-25
 * saves emit them at `0xD0` (one of several FL 25 +16 relocations
 * also seen with track data). Payload is a dense array of 24-byte
 * note records; see `decodeNotes`.
 */
const OP_PATTERN_NOTES = 0xe0;
/** Pattern color (uint32 LE, RGBA byte-packed per unpackRGBA). */
const OP_PATTERN_COLOR = 0x96;
/** Pattern length (uint32 LE, length in PPQ ticks). Zero = default. */
const OP_PATTERN_LENGTH = 0xa4;
/** Pattern looped flag (u8 bool). Only emitted when looped=true. */
const OP_PATTERN_LOOPED = 0x1a;
/**
 * Arrangement identity marker (uint16 LE id). FL 25 base projects
 * have exactly one, id=0, default name "Arrangement".
 */
const OP_ARRANGEMENT_NEW = 0x63;
/** Arrangement name (UTF-16LE null-terminated). */
const OP_ARRANGEMENT_NAME = 0xf1;
/**
 * Per-track data blob (FL 25's location for the 70-byte per-track
 * descriptor). FL 25 emits 500 track slots by default even when
 * most are empty; counting these gives the project's track count.
 */
const OP_TRACK_DATA = 0xee;
/**
 * the arrangement-playlist event (DATA+25) — array of 32-byte (pre-FL-21) or
 * 60-byte (FL 21+) clip records. FL simply omits the event when the
 * arrangement has no clips, so the absence of 0xD9 is a valid
 * "empty playlist" encoding rather than a parse failure.
 */
const OP_PLAYLIST = 0xd9;

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
    if (ev.opcode === OP_PLUGIN_COLOR && ev.kind === "u32" && current.color === undefined) {
      current.color = unpackRGBA(ev.value);
      continue;
    }
    if (ev.opcode === OP_CHANNEL_LEVELS && ev.kind === "blob" && current.levels === undefined) {
      const levels = decodeLevels(ev.payload);
      if (levels !== undefined) current.levels = levels;
      continue;
    }
    if (ev.opcode === OP_CHANNEL_SAMPLE_PATH && ev.kind === "blob") {
      current.sample_path = decodeUtf16LeBytes(ev.payload);
      continue;
    }
    if (ev.opcode === OP_PLUGIN_INTERNAL_NAME && ev.kind === "blob" && current.plugin === undefined) {
      const internalName = decodeUtf16LeBytes(ev.payload);
      // Sampler channels emit an empty 0xC9 as a placeholder; treat
      // that as "no plugin" so the field stays undefined.
      if (internalName.length > 0) current.plugin = { internalName };
      continue;
    }
    if (
      ev.opcode === OP_PLUGIN_STATE &&
      ev.kind === "blob" &&
      current.plugin !== undefined &&
      current.plugin.internalName === "Fruity Wrapper" &&
      current.plugin.name === undefined
    ) {
      const info = decodeVSTWrapper(ev.payload);
      if (info.name !== undefined) current.plugin.name = info.name;
      if (info.vendor !== undefined) current.plugin.vendor = info.vendor;
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
  let pendingInsert: MixerInsert = { index: 0, slots: [] };
  /**
   * Slot currently being *accumulated*. Unlike `pendingInsert`, this is
   * pre-open: events destined for slot K accumulate into `pendingSlot`
   * until the 0x62 event that carries K closes it and pushes to
   * `pendingInsert.slots`.
   *
   * Why this shape: FL writes a slot's plugin-identifying events (0xCB
   * plugin name, 0xD5 plugin state, etc.) BEFORE the 0x62 marker that
   * names the slot. So 0x62 is the slot CLOSER, not an opener.
   */
  let pendingSlot: MixerSlot = { index: 0 };
  /**
   * True once we've seen any insert-section marker — 0x62 (slot close),
   * 0x93 (insert close), or 0xCC (insert name). Before this point, the
   * walker is still in the channel section of the stream and must not
   * attribute shared opcodes (0xCB) to slots. The channel walker
   * handles those in its own scope.
   */
  let inMixerSection = false;

  for (const ev of events) {
    if (ev.opcode === OP_INSERT_END && ev.kind === "u32") {
      inMixerSection = true;
      // The 0x93 value IS the output-routing target. Two default
      // sentinels in the wild:
      //   - `-1` / 0xFFFFFFFF — standard "no route, implicit to master"
      //   - value === insert.index — master (index 0) outputs to 0
      //     as its own default. Python flp-info treats this as
      //     "no user-set routing" and reports None; we mirror that.
      // Anything else is a genuine routing override that diffs
      // should surface.
      if (ev.value !== ROUTING_UNSET && ev.value !== pendingInsert.index) {
        pendingInsert.output = ev.value;
      }
      // pendingSlot at this point holds any trailing insert-level
      // events (routing etc.) that fire after the last 0x62 — drop
      // those; they don't belong to any slot.
      inserts.push(pendingInsert);
      pendingInsert = { index: inserts.length, slots: [] };
      pendingSlot = { index: 0 };
      continue;
    }
    if (ev.opcode === OP_NEW_SLOT && ev.kind === "u16") {
      inMixerSection = true;
      pendingSlot.index = ev.value;
      pendingInsert.slots.push(pendingSlot);
      pendingSlot = { index: ev.value + 1 };
      continue;
    }
    if (ev.opcode === OP_INSERT_NAME && ev.kind === "blob" && pendingInsert.name === undefined) {
      inMixerSection = true;
      pendingInsert.name = decodeUtf16LeBytes(ev.payload);
      continue;
    }
    if (ev.opcode === OP_INSERT_COLOR && ev.kind === "u32" && pendingInsert.color === undefined && inMixerSection) {
      pendingInsert.color = unpackRGBA(ev.value);
      continue;
    }
    if (ev.opcode === OP_INSERT_ICON && ev.kind === "u16" && pendingInsert.icon === undefined && inMixerSection) {
      pendingInsert.icon = ev.value;
      continue;
    }
    if (ev.opcode === OP_INSERT_INPUT && ev.kind === "u32" && pendingInsert.input === undefined && inMixerSection) {
      if (ev.value !== ROUTING_UNSET) pendingInsert.input = ev.value;
      continue;
    }
    if (
      ev.opcode === OP_NAME &&
      ev.kind === "blob" &&
      inMixerSection &&
      pendingSlot.pluginName === undefined
    ) {
      pendingSlot.pluginName = decodeUtf16LeBytes(ev.payload);
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
      if (!byId.has(currentId)) byId.set(currentId, { id: currentId, notes: [] });
      continue;
    }
    if (ev.opcode === OP_PATTERN_NAME && ev.kind === "blob" && currentId !== undefined) {
      const p = byId.get(currentId);
      if (p && p.name === undefined) p.name = decodeUtf16LeBytes(ev.payload);
      continue;
    }
    if (ev.opcode === OP_PATTERN_NOTES && ev.kind === "blob" && currentId !== undefined) {
      const p = byId.get(currentId);
      if (p) {
        // Multiple 0xE0 blobs within a pattern are concatenated in
        // stream order — preserves timeline ordering.
        for (const note of decodeNotes(ev.payload)) p.notes.push(note);
      }
      continue;
    }
    if (ev.opcode === OP_PATTERN_COLOR && ev.kind === "u32" && currentId !== undefined) {
      const p = byId.get(currentId);
      if (p && p.color === undefined) p.color = unpackRGBA(ev.value);
      continue;
    }
    if (ev.opcode === OP_PATTERN_LENGTH && ev.kind === "u32" && currentId !== undefined) {
      const p = byId.get(currentId);
      if (p && p.length === undefined) p.length = ev.value;
      continue;
    }
    if (ev.opcode === OP_PATTERN_LOOPED && ev.kind === "u8" && currentId !== undefined) {
      const p = byId.get(currentId);
      // FL emits 0x1A only for looped patterns (value=1). A missing
      // event means `looped` stays undefined (default false).
      if (p && p.looped === undefined) p.looped = ev.value !== 0;
      continue;
    }
  }

  return [...byId.values()];
}

/**
 * Walks the event stream and accumulates arrangements.
 *
 * Arrangement-identity rule: opcode `0x63` (uint16 LE)
 * announces a new arrangement with the carried id. Subsequent
 * arrangement-scoped events (name, track descriptors) belong to the
 * most-recently-announced arrangement. Each arrangement's `trackCount`
 * is the number of `0xEE` (per-track data) events that appear between
 * its `0x63` and the next `0x63`.
 *
 * FL 25 base projects emit exactly one `0x63` with id=0, name
 * "Arrangement", and 500 `0xEE` events.
 */
export function buildArrangements(events: readonly FLPEvent[]): Arrangement[] {
  const arrangements: Arrangement[] = [];
  let current: Arrangement | undefined;

  for (const ev of events) {
    if (ev.opcode === OP_ARRANGEMENT_NEW && ev.kind === "u16") {
      current = { id: ev.value, trackCount: 0, clips: [] };
      arrangements.push(current);
      continue;
    }
    if (!current) continue;
    if (ev.opcode === OP_ARRANGEMENT_NAME && ev.kind === "blob" && current.name === undefined) {
      current.name = decodeUtf16LeBytes(ev.payload);
      continue;
    }
    if (ev.opcode === OP_TRACK_DATA) {
      current.trackCount++;
      continue;
    }
    if (ev.opcode === OP_PLAYLIST && ev.kind === "blob") {
      // Multiple 0xD9 blobs (if they ever occur) are concatenated in
      // stream order, preserving clip-declaration ordering.
      for (const clip of decodeClips(ev.payload)) current.clips.push(clip);
      continue;
    }
  }

  return arrangements;
}
