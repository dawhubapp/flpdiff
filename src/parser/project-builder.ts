import type { FLPEvent } from "./event.ts";
import { decodeUtf16LeBytes, decodeUtf8Bytes } from "./primitives.ts";
import { decodeVSTWrapper } from "./vst-wrapper.ts";
import { type Channel, classifyChannelKind, unpackRGBA, decodeLevels } from "../model/channel.ts";
// unpackRGBA is re-used for pattern color (0x96) — same byte packing as 0x80.
import {
  type MixerInsert,
  type MixerSlot,
  type MixerParamRecord,
  decodeInsertFlags,
  decodeMixerParams,
} from "../model/mixer-insert.ts";
import { type Pattern, decodeNotes, decodeControllers } from "../model/pattern.ts";
import { type Arrangement, type Track, type TimeMarker, decodeClips, decodeTimeMarkerPosition, decodeTrackData } from "../model/arrangement.ts";
import { type ProjectMetadata, decodeTimestamp } from "../model/metadata.ts";

/**
 * Opcode constants for the entity-boundary events. Each is a format fact
 * cross-referenced against the dev repo's `docs/fl25-event-format.md`
 * and the clean-room spec at `ts/docs/flp-format-spec.md`; naming here is
 * our own (not borrowed from the reference parser).
 */
const OP_NEW_CHANNEL = 0x40;
const OP_CHANNEL_TYPE = 0x15;
/** Channel "is enabled" flag (u8 bool). Emitted per channel. */
const OP_CHANNEL_ENABLED = 0x00;
/** Channel ping-pong loop flag (u8 bool). */
const OP_CHANNEL_PING_PONG = 0x14;
/** Channel "is locked" flag (u8 bool, FL 12.3+). */
const OP_CHANNEL_LOCKED = 0x20;
/**
 * Channel "routed to" — int8 (signed). Mixer insert index this
 * channel feeds into; `-1` means unrouted / default.
 */
const OP_CHANNEL_ROUTED_TO = 0x16;
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
/**
 * Legacy channel-name fallback (UTF-16LE). FL 9-era files emit 0xC0
 * for channel names where FL 25 files emit 0xCB; when both are
 * present, 0xCB wins (matches the reference parser's first-wins
 * priority over identifier order).
 */
const OP_CHANNEL_NAME = 0xc0;
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
/**
 * Insert flags bitmask blob. FL 25 relocated this opcode from the
 * pre-FL-25 `0xDC` to `0xEC`, matching the same +16 offset seen
 * with track data and pattern notes. 12-byte payload:
 * 4 reserved + uint32 flags + 4 reserved.
 */
const OP_INSERT_FLAGS = 0xec;
/**
 * Project-level MixerParams blob. Carries all per-insert /
 * per-slot "MixerParams" records in a single payload. Record
 * layout decoded by `decodeMixerParams` — each record's
 * `channel_data` field packs `(insertIdx << 6) | slotIdx`.
 * The walker collects all records and applies them post-walk.
 */
const OP_MIXER_PARAMS = 0xe1;
/** MixerParams record IDs we surface in the project model. */
const MP_SLOT_ENABLED = 0;
const MP_SLOT_MIX = 1;
const MP_INSERT_VOLUME = 192;
const MP_INSERT_PAN = 193;
const MP_INSERT_STEREO_SEP = 194;
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
/**
 * Per-pattern controller-event blob. (This TS constant used to be
 * 0xCF — the project artists opcode — which is unrelated; the parity
 * harness on the local corpus caught the mistake. Controllers never
 * fired on real files with thousands of per-pattern controller
 * records.)
 */
const OP_PATTERN_CONTROLLERS = 0xdf;
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
/** Track name (UTF-16LE on FL 25; blank / not emitted by default). */
const OP_TRACK_NAME = 0xef;
/**
 * Arrangement playlist clips — array of 32-byte (pre-FL-21) or
 * 60-byte (FL 21+) clip records. FL simply omits the event when the
 * arrangement has no clips, so the absence of `0xE9` is a valid
 * "empty playlist" encoding rather than a parse failure.
 *
 * Note: the TS parser historically used 0xD9 here, which was wrong;
 * the parity harness (tools/parity/) caught the drift on the first
 * real corpus run.
 */
const OP_PLAYLIST = 0xe9;
/** Time-marker position (uint32 with high bit 0x08000000 flagging signature markers). */
const OP_TIMEMARKER_POSITION = 0x94;
/** Time-marker numerator (u8). Only meaningful for signature markers. */
const OP_TIMEMARKER_NUMERATOR = 0x21;
/** Time-marker denominator (u8). Only meaningful for signature markers. */
const OP_TIMEMARKER_DENOMINATOR = 0x22;
/** Time-marker name (UTF-16LE null-terminated). */
const OP_TIMEMARKER_NAME = 0xcd;

/**
 * Project-level metadata opcodes. the reference parser lists them as `project-level events`
 * events in the envelope section that fires before channels/patterns/
 * mixer. We pick up the ones `flp-info --format=json` exposes.
 */
const OP_PROJECT_LOOP_ACTIVE = 0x09; // the loop-active event (BYTE, bool)
const OP_PROJECT_SHOW_INFO = 0x0a; // the show-info event (BYTE, bool)
const OP_PROJECT_TITLE = 0xc2; // TEXT+2, UTF-16LE null-terminated
const OP_PROJECT_COMMENTS = 0xc3; // TEXT+3, UTF-16LE (plaintext, pre-FL-1.2.10)
const OP_PROJECT_URL = 0xc5; // TEXT+5, UTF-16LE
const OP_PROJECT_RTF_COMMENTS = 0xc6; // TEXT+6, UTF-16LE (RTF, FL 1.2.10+)
const OP_PROJECT_FL_VERSION = 0xc7; // TEXT+7, ASCII "A.B.C" or "A.B.C.D"
const OP_PROJECT_DATA_PATH = 0xca; // TEXT+10, UTF-16LE
const OP_PROJECT_GENRE = 0xce; // TEXT+14, UTF-16LE
const OP_PROJECT_ARTISTS = 0xcf; // TEXT+15, UTF-16LE
const OP_PROJECT_FL_BUILD = 0x9f; // DWORD+31, uint32 LE
const OP_PROJECT_TIMESTAMP = 0xed; // DATA+29, 16-byte the timestamp event class (2× float64 LE)

function parseFlVersionAscii(value: string): ProjectMetadata["version"] | undefined {
  // Python: `FLVersion(*tuple(int(p) for p in event.value.split('.')))`.
  // Format is either "A.B.C" (build=None) or "A.B.C.D".
  const parts = value.split(".").map((p) => Number(p));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return {
    major: parts[0]!,
    minor: parts[1]!,
    patch: parts[2]!,
    build: parts.length >= 4 ? parts[3]! : 0,
  };
}

/**
 * Single pass over the event stream to pull out project metadata.
 * Doesn't need scope tracking — these opcodes are unique at the
 * project level and don't overlap channel/mixer scopes.
 */
export function buildMetadata(events: readonly FLPEvent[]): ProjectMetadata {
  const out: ProjectMetadata = {};
  let flBuild: number | undefined;
  for (const ev of events) {
    if (ev.opcode === OP_PROJECT_TITLE && ev.kind === "blob" && out.title === undefined) {
      const s = decodeUtf16LeBytes(ev.payload);
      if (s.length > 0) out.title = s;
      continue;
    }
    if (ev.opcode === OP_PROJECT_ARTISTS && ev.kind === "blob" && out.artists === undefined) {
      const s = decodeUtf16LeBytes(ev.payload);
      if (s.length > 0) out.artists = s;
      continue;
    }
    if (ev.opcode === OP_PROJECT_GENRE && ev.kind === "blob" && out.genre === undefined) {
      const s = decodeUtf16LeBytes(ev.payload);
      if (s.length > 0) out.genre = s;
      continue;
    }
    if (ev.opcode === OP_PROJECT_URL && ev.kind === "blob" && out.url === undefined) {
      const s = decodeUtf16LeBytes(ev.payload);
      if (s.length > 0) out.url = s;
      continue;
    }
    if (ev.opcode === OP_PROJECT_DATA_PATH && ev.kind === "blob" && out.dataPath === undefined) {
      const s = decodeUtf16LeBytes(ev.payload);
      if (s.length > 0) out.dataPath = s;
      continue;
    }
    if (ev.opcode === OP_PROJECT_COMMENTS && ev.kind === "blob" && out.comments === undefined) {
      const s = decodeUtf16LeBytes(ev.payload);
      if (s.length > 0) out.comments = s;
      continue;
    }
    if (ev.opcode === OP_PROJECT_RTF_COMMENTS && ev.kind === "blob" && out.comments === undefined) {
      // Prefer plaintext `0xC3` if both are present (first-wins order).
      const s = decodeUtf16LeBytes(ev.payload);
      if (s.length > 0) out.comments = s;
      continue;
    }
    if (ev.opcode === OP_PROJECT_FL_VERSION && ev.kind === "blob" && out.version === undefined) {
      // ASCII (subset of UTF-8), e.g. "25.2.4" or "25.2.4.4960".
      const s = decodeUtf8Bytes(ev.payload);
      const v = parseFlVersionAscii(s);
      if (v !== undefined) out.version = v;
      continue;
    }
    if (ev.opcode === OP_PROJECT_FL_BUILD && ev.kind === "u32") {
      flBuild = ev.value;
      continue;
    }
    if (ev.opcode === OP_PROJECT_LOOP_ACTIVE && ev.kind === "u8" && out.looped === undefined) {
      out.looped = ev.value !== 0;
      continue;
    }
    if (ev.opcode === OP_PROJECT_SHOW_INFO && ev.kind === "u8" && out.showInfo === undefined) {
      out.showInfo = ev.value !== 0;
      continue;
    }
    if (ev.opcode === OP_PROJECT_TIMESTAMP && ev.kind === "blob" && out.createdOn === undefined) {
      const ts = decodeTimestamp(ev.payload);
      if (ts !== undefined) {
        out.createdOn = ts.createdOn;
        out.timeSpent = ts.timeSpent;
      }
      continue;
    }
  }
  // If the 0xC7 FL-version string lacked a 4th (build) component,
  // fall back to the 0x9F FL-build uint32 when present.
  if (out.version !== undefined && out.version.build === 0 && flBuild !== undefined) {
    out.version = { ...out.version, build: flBuild };
  }
  return out;
}

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
/**
 * Text-event encoding predicate. Text events (TEXT range 0xC0–0xCF)
 * are ASCII on FL <11.5 and UTF-16LE on FL 11.5+. When the channel
 * walker sees a text-range event (0xC0 channel name, primarily), it
 * needs to know which encoding to use. `legacyText` is true for
 * pre-FL-11.5.
 */
function isLegacyText(meta: ProjectMetadata | undefined): boolean {
  const v = meta?.version;
  if (!v) return false;
  return v.major < 11 || (v.major === 11 && v.minor < 5);
}

function decodeTextEvent(payload: Uint8Array, legacy: boolean): string {
  if (legacy) return decodeUtf8Bytes(payload);
  return decodeUtf16LeBytes(payload);
}

export function buildChannels(
  events: readonly FLPEvent[],
  metadata?: ProjectMetadata,
): Channel[] {
  const legacy = isLegacyText(metadata);
  const channels: Channel[] = [];
  let current: Channel | undefined;
  /**
   * Walker scope. Starts as "outside" (neither channel nor slot). Flips
   * to "channel" on every 0x40 and to "slot" on every 0x62. Only
   * channel-scoped events are attributed to `current`.
   */
  let scope: "outside" | "channel" | "slot" = "outside";
  /**
   * Tracks, per channel iid, whether a channel-level `0xC9`
   * plugin-internal-name event fired — regardless of its payload
   * value. The sampler-reclassification rule below requires the
   * event to be PRESENT (even if empty); pre-FL-12 layouts often
   * skip `0xC9` on certain channel types and TS was happily
   * flipping those to sampler when the reference left them as
   * instrument.
   */
  const sawPluginEvent = new Set<number>();

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
    // Any mixer-section opcode closes channel scope for good. Without
    // this, on FL 20-era layouts a stray `0xC9` inside the mixer
    // section — fired 3000+ events after the last `0x40` and before
    // the first `0x62` — gets misattributed to the final channel as
    // a phantom plugin.internalName (e.g. "Fruity Parametric EQ 2"),
    // blocking the sampler-reclassification rule.
    if (
      ev.opcode === OP_INSERT_END ||
      ev.opcode === OP_INSERT_NAME ||
      ev.opcode === OP_INSERT_FLAGS
    ) {
      scope = "outside";
      continue;
    }
    if (scope !== "channel" || !current) continue;

    if (ev.opcode === OP_CHANNEL_TYPE && ev.kind === "u8") {
      current.kind = classifyChannelKind(ev.value);
      continue;
    }
    if (ev.opcode === OP_CHANNEL_ENABLED && ev.kind === "u8" && current.enabled === undefined) {
      current.enabled = ev.value !== 0;
      continue;
    }
    if (ev.opcode === OP_CHANNEL_PING_PONG && ev.kind === "u8" && current.pingPongLoop === undefined) {
      current.pingPongLoop = ev.value !== 0;
      continue;
    }
    if (ev.opcode === OP_CHANNEL_LOCKED && ev.kind === "u8" && current.locked === undefined) {
      current.locked = ev.value !== 0;
      continue;
    }
    if (ev.opcode === OP_CHANNEL_ROUTED_TO && ev.kind === "u8" && current.targetInsert === undefined) {
      // The event is BYTE-range u8; treat as signed int8. 0xFF → -1 (unrouted).
      current.targetInsert = ev.value > 127 ? ev.value - 256 : ev.value;
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
      sawPluginEvent.add(current.iid);
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
      current.name = decodeTextEvent(ev.payload, legacy);
      continue;
    }
    if (
      ev.opcode === OP_CHANNEL_NAME &&
      ev.kind === "blob" &&
      current.name === undefined
    ) {
      // Fallback channel-name source — matches the reference parser's first-wins
      // order `the event projection(the plugin-name event, the legacy channel-name event)`. FL 9
      // emits names here; FL 25 uses 0xCB (OP_NAME) above.
      current.name = decodeTextEvent(ev.payload, legacy);
      continue;
    }
    // scope hygiene: `current` loses channel-scope events once we cross
    // into a slot pack, but that's intentional — slot content is handled
    // by buildMixerInserts.
  }

  // FL writes `channel-type enum == Instrument (4)` as a placeholder for
  // "audio clip slot before a sample is loaded" as well as for real
  // VST instrument channels. When the channel also has a sample
  // path AND a channel-level `0xC9` plugin-internal-name event
  // (even if empty-valued), reclassify as Sampler — that matches
  // the reference parser's behaviour. The `sawPluginEvent` check
  // matters on pre-FL-12 files where some instrument channels don't
  // emit `0xC9` at all — without it TS would flip them wrongly.
  for (const ch of channels) {
    if (
      ch.kind === "instrument" &&
      ch.sample_path !== undefined &&
      sawPluginEvent.has(ch.iid) &&
      ch.plugin === undefined
    ) {
      ch.kind = "sampler";
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
  /**
   * MixerParams records buffered during the walk for post-attribution.
   * FL emits a single 0xE1 blob with records for ALL inserts/slots;
   * we can't attribute them to `pendingInsert` as we go because the
   * blob lands before most inserts exist. Collect, then apply after
   * the walk.
   */
  let mixerParamsRecords: MixerParamRecord[] = [];
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
   * Tracks whether the current insert has seen its first slot-index
   * (0x62) marker yet. The reference parser's slot-divide step skips
   * the FIRST separator (doesn't yield a group before it); subsequent
   * separators each close a slot group. Concretely: events BEFORE
   * 0x62 value=0 AND events BETWEEN 0x62 value=0 AND 0x62 value=1
   * both belong to slot 0 in the reference's accounting. Our walker
   * used to push a slot on EVERY 0x62, creating a phantom extra slot
   * whenever plugin events straddled the first marker — a 46-slot
   * over-count on one fixture. We now match: swallow the first 0x62
   * per insert, push only on subsequent ones, then flush the final
   * pendingSlot at 0x93.
   */
  let firstSlotSeen = false;
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
      // Final slot flush at insert close. Two layout regimes:
      //  - FL 25 (10 0x62 markers per insert): the last 0x62 opened
      //    slot 9; 0x93 closes it. firstSlotSeen is true, so push
      //    unconditionally.
      //  - FL 9 (zero 0x62 markers): firstSlotSeen never flipped.
      //    pendingSlot is the one catch-all slot the reference parser's divide would
      //    yield. Push only if it carries any plugin signal — otherwise
      //    the insert genuinely has no slots.
      if (firstSlotSeen) {
        pendingInsert.slots.push(pendingSlot);
      } else if (pendingSlot.hasPlugin === true || pendingSlot.pluginName !== undefined) {
        pendingInsert.slots.push(pendingSlot);
      }
      inserts.push(pendingInsert);
      pendingInsert = { index: inserts.length, slots: [] };
      pendingSlot = { index: 0 };
      firstSlotSeen = false;
      continue;
    }
    if (ev.opcode === OP_NEW_SLOT && ev.kind === "u16") {
      inMixerSection = true;
      if (!firstSlotSeen) {
        // First 0x62 of this insert: open slot 0, don't push yet.
        // Events already accumulated on pendingSlot belong to this
        // slot (per the reference's slot-divide semantics).
        firstSlotSeen = true;
        pendingSlot.index = ev.value;
      } else {
        // Subsequent 0x62: close the CURRENT slot and open the next.
        // pendingSlot already has its index from the previous marker.
        pendingInsert.slots.push(pendingSlot);
        pendingSlot = { index: ev.value };
      }
      continue;
    }
    if (ev.opcode === OP_INSERT_NAME && ev.kind === "blob" && pendingInsert.name === undefined) {
      inMixerSection = true;
      // Always record whatever the name event decoded to — empty
      // string included. The reference parser returns '' for empty
      // UTF-16 payloads (FL 9 emits 1-byte null placeholders on
      // every insert boundary). Callers that want "user-assigned
      // name only" should filter by `name.length > 0` (e.g. Pass 1's
      // `named_inserts`).
      pendingInsert.name = decodeUtf16LeBytes(ev.payload);
      continue;
    }
    if (ev.opcode === OP_INSERT_COLOR && ev.kind === "u32" && pendingInsert.color === undefined) {
      inMixerSection = true;
      pendingInsert.color = unpackRGBA(ev.value);
      continue;
    }
    if (ev.opcode === OP_INSERT_ICON && ev.kind === "u16" && pendingInsert.icon === undefined) {
      inMixerSection = true;
      pendingInsert.icon = ev.value;
      continue;
    }
    if (ev.opcode === OP_INSERT_INPUT && ev.kind === "u32" && pendingInsert.input === undefined) {
      inMixerSection = true;
      if (ev.value !== ROUTING_UNSET) pendingInsert.input = ev.value;
      continue;
    }
    if (ev.opcode === OP_INSERT_FLAGS && ev.kind === "blob" && pendingInsert.flags === undefined) {
      inMixerSection = true;
      const flags = decodeInsertFlags(ev.payload);
      if (flags !== undefined) pendingInsert.flags = flags;
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
    if (ev.opcode === OP_PLUGIN_STATE && ev.kind === "blob" && inMixerSection) {
      // Mark the pending slot as plugin-bearing. Plugin presence is
      // keyed off `0xD5` (plugin state) presence in the slot's event
      // subtree. Captures native plugins that emit `0xD5` without a
      // companion `0xCB` name event.
      pendingSlot.hasPlugin = true;
      continue;
    }
    if (ev.opcode === OP_MIXER_PARAMS && ev.kind === "blob") {
      // Buffer; applied post-walk.
      mixerParamsRecords = decodeMixerParams(ev.payload);
      continue;
    }
  }

  // Apply MixerParams records to the built inserts. Each record has
  // `insertIdx` (0..127) and `slotIdx` (0..63). The insertIdx fields
  // we observe in the wild are sparse — FL stores records only for
  // insert positions that actually exist, with sparse gaps.
  //
  // Insert mapping: our `inserts` array order is 0 = master, then
  // visible inserts in the order their 0x93 events fired. FL's
  // `insertIdx` in the channel_data field tracks the SAME
  // enumeration; records whose insertIdx falls outside
  // `[0, inserts.length)` are silently dropped (they target insert
  // slots FL allocated but didn't surface via 0x93 — the sparse
  // tail we don't model).
  for (const rec of mixerParamsRecords) {
    const ins = inserts[rec.insertIdx];
    if (!ins) continue;
    if (rec.id === MP_INSERT_VOLUME) ins.volume = rec.msg;
    else if (rec.id === MP_INSERT_PAN) ins.pan = rec.msg;
    else if (rec.id === MP_INSERT_STEREO_SEP) ins.stereoSeparation = rec.msg;
    else if (rec.id === MP_SLOT_ENABLED) {
      const slot = ins.slots[rec.slotIdx];
      if (slot) slot.enabled = rec.msg !== 0;
    } else if (rec.id === MP_SLOT_MIX) {
      const slot = ins.slots[rec.slotIdx];
      if (slot) slot.mix = rec.msg;
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
      if (!byId.has(currentId)) byId.set(currentId, { id: currentId, notes: [], controllers: [] });
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
    if (
      ev.opcode === OP_PATTERN_CONTROLLERS &&
      ev.kind === "blob" &&
      currentId !== undefined
    ) {
      const p = byId.get(currentId);
      if (p) {
        for (const c of decodeControllers(ev.payload)) p.controllers.push(c);
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
 * Track-index sentinel: a playlist clip's `track_rvidx` must be
 * `<= max_idx` to be assigned to a track. For FL 12.9.1+ (our scope)
 * max_idx = 499. For older FL it's 198. FL stores uninitialised /
 * garbage clip slots with `track_rvidx` values in the 0x8000..0xFFFF
 * range; those don't belong to any real track and should be dropped.
 */
const PLAYLIST_MAX_TRACK_IDX = 499;
/**
 * Pattern-vs-channel discriminator. If `item_index <= pattern_base
 * (20480)` the record references a channel (item_index = iid);
 * otherwise it references a pattern (id = item_index - pattern_base).
 */
const PLAYLIST_PATTERN_BASE = 20480;

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
 *
 * Playlist clips are filtered: records with out-of-range
 * `track_rvidx` (FL stores garbage sentinel values in uninitialised
 * slots) and records that reference non-existent channels or
 * patterns are dropped. This keeps `arrangement.clips` tight to
 * "clips actually visible on tracks" so downstream diffs don't
 * churn on orphans.
 */
export function buildArrangements(
  events: readonly FLPEvent[],
  channels: readonly { iid: number }[] = [],
  patterns: readonly { id: number }[] = [],
): Arrangement[] {
  const channelIids = new Set(channels.map((c) => c.iid));
  const patternIds = new Set(patterns.map((p) => p.id));

  const keepClip = (clip: { item_index: number; track_rvidx: number }): boolean => {
    if (clip.track_rvidx > PLAYLIST_MAX_TRACK_IDX) return false;
    if (clip.item_index <= PLAYLIST_PATTERN_BASE) {
      return channelIids.has(clip.item_index);
    }
    return patternIds.has(clip.item_index - PLAYLIST_PATTERN_BASE);
  };
  const arrangements: Arrangement[] = [];
  let current: Arrangement | undefined;
  /**
   * Time-marker currently being accumulated. Opens on each 0x94
   * time-marker position event; subsequent 0x21/0x22/0xCD events within
   * the same arrangement attach to this marker. Pushed to
   * `current.timemarkers` on the NEXT 0x94 or at arrangement close.
   */
  let pendingMarker: TimeMarker | undefined;

  const flushMarker = () => {
    if (pendingMarker !== undefined && current !== undefined) {
      current.timemarkers.push(pendingMarker);
    }
    pendingMarker = undefined;
  };

  for (const ev of events) {
    if (ev.opcode === OP_ARRANGEMENT_NEW && ev.kind === "u16") {
      flushMarker();
      current = { id: ev.value, tracks: [], clips: [], timemarkers: [] };
      arrangements.push(current);
      continue;
    }
    if (!current) continue;
    if (ev.opcode === OP_ARRANGEMENT_NAME && ev.kind === "blob" && current.name === undefined) {
      current.name = decodeUtf16LeBytes(ev.payload);
      continue;
    }
    if (ev.opcode === OP_TRACK_DATA && ev.kind === "blob") {
      const track = decodeTrackData(ev.payload, current.tracks.length);
      current.tracks.push(track);
      continue;
    }
    if (ev.opcode === OP_TRACK_NAME && ev.kind === "blob") {
      // 0xEF follows the 0xEE blob it names. Attach to the most-
      // recently-pushed track. FL emits this event only when the
      // user has set a custom name; default tracks get no 0xEF.
      const last = current.tracks[current.tracks.length - 1];
      if (last) last.name = decodeUtf16LeBytes(ev.payload);
      continue;
    }
    if (ev.opcode === OP_PLAYLIST && ev.kind === "blob") {
      for (const clip of decodeClips(ev.payload)) {
        if (keepClip(clip)) current.clips.push(clip);
      }
      continue;
    }
    if (ev.opcode === OP_TIMEMARKER_POSITION && ev.kind === "u32") {
      flushMarker();
      const { kind, position } = decodeTimeMarkerPosition(ev.value);
      pendingMarker = { kind, position };
      continue;
    }
    if (ev.opcode === OP_TIMEMARKER_NAME && ev.kind === "blob" && pendingMarker) {
      pendingMarker.name = decodeUtf16LeBytes(ev.payload);
      continue;
    }
    if (ev.opcode === OP_TIMEMARKER_NUMERATOR && ev.kind === "u8" && pendingMarker) {
      pendingMarker.numerator = ev.value;
      continue;
    }
    if (ev.opcode === OP_TIMEMARKER_DENOMINATOR && ev.kind === "u8" && pendingMarker) {
      pendingMarker.denominator = ev.value;
      continue;
    }
  }
  flushMarker();

  return arrangements;
}
