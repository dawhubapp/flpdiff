/**
 * Presentation layer — projects the binary-faithful `FLPProject` model
 * into the exact JSON shape Python's `flp-info --format=json` emits.
 *
 * Contract: see `docs/flp-info-shape.md`. This module is the single
 * source of truth for unit normalisation (FL raw int ↔ Python float
 * space), field renames (`id` → `iid`, `index` vs `iid`), and the
 * `_type` tag discriminators that Python's encoder stamps on nested
 * objects.
 *
 * Parser stays raw/honest-to-binary. This layer owns the Python-facing
 * interop surface. Used by:
 *   - `tools/parity/ts-flp-info-shape.ts` (Pass 2 harness)
 *   - future diff engine (Phase 3.4) when semantic comparison is
 *     more useful than raw-byte diff.
 */
import type { FLPProject } from "../parser/flp-project.ts";
import type { Channel, RGBA, ChannelPlugin } from "../model/channel.ts";
import type { MixerInsert, MixerSlot } from "../model/mixer-insert.ts";
import type { Pattern, Note } from "../model/pattern.ts";
import type { Arrangement, TimeMarker } from "../model/arrangement.ts";

// --- JSON shape types (mirroring Python's `flp-info` output) ---------- //

type RgbaJson = {
  _type: "RGBA";
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

type PathJson = { _type: "path"; value: string };

type PluginJson = {
  _type: "Plugin";
  name: string;
  vendor: string | null;
  is_vst: boolean;
  state: null;
};

type ChannelJson = {
  _type: "Channel";
  iid: number;
  kind: string;
  name: string | null;
  sample_path: PathJson | null;
  plugin: PluginJson | null;
  color: RgbaJson | null;
  pan: number;
  volume: number;
  enabled: boolean;
  muted: boolean;
  target_insert: number | null;
  automation_points: unknown[];
};

type NoteJson = {
  _type: "Note";
  position: number;
  length: number;
  key: number;
  channel_iid: number;
  pan: number;
  velocity: number;
  fine_pitch: number;
  release: number;
};

type ControllerJson = Record<string, unknown>;

type PatternJson = {
  _type: "Pattern";
  iid: number;
  name: string | null;
  color: RgbaJson | null;
  length: number | null;
  looped: boolean;
  notes: NoteJson[];
  controllers: ControllerJson[];
};

type MixerSlotJson = {
  _type: "MixerSlot";
  index: number;
  enabled: boolean;
  plugin: PluginJson | null;
};

type MixerInsertJson = {
  _type: "MixerInsert";
  index: number;
  name: string | null;
  color: RgbaJson | null;
  enabled: boolean;
  locked: boolean;
  pan: number | null;
  volume: number | null;
  stereo_separation: number | null;
  slots: MixerSlotJson[];
  routes_to: number[];
};

type MixerJson = {
  _type: "Mixer";
  inserts: MixerInsertJson[];
};

type TrackJson = {
  _type: "Track";
  index: number;
  name: string | null;
  color: RgbaJson | null;
  height: number;
  muted: boolean;
  items: unknown[];
};

type TimeMarkerJson = {
  _type: "TimeMarker";
  position: number;
  name: string | null;
  numerator: number | null;
  denominator: number | null;
};

type ArrangementJson = {
  _type: "Arrangement";
  index: number;
  name: string | null;
  tracks: TrackJson[];
  timemarkers: TimeMarkerJson[];
};

type FLVersionJson = {
  _type: "FLVersion";
  major: number;
  minor: number;
  patch: number;
  build: number;
};

type TimeSignatureJson = {
  _type: "TimeSignature";
  numerator: number;
  denominator: number;
};

type DatetimeJson = { _type: "datetime"; iso: string };
type TimedeltaJson = { _type: "timedelta"; seconds: number };

type MetadataJson = {
  _type: "ProjectMetadata";
  title: string;
  artists: string;
  genre: string;
  comments: string;
  format: string;
  ppq: number;
  tempo: number;
  time_signature: TimeSignatureJson | null;
  main_pitch: number;
  main_volume: number | null;
  pan_law: number;
  looped: boolean;
  show_info: boolean;
  url: string | null;
  data_path: PathJson | null;
  created_on: DatetimeJson | null;
  time_spent: TimedeltaJson | null;
  version: FLVersionJson;
};

type OpaqueEventJson = {
  _type: "OpaqueEvent";
  event_id: number;
  sha256: string;
  size: number;
  hint: string | null;
};

export type FlpInfoJson = {
  _type: "FLPProject";
  metadata: MetadataJson;
  channels: ChannelJson[];
  patterns: PatternJson[];
  mixer: MixerJson;
  arrangements: ArrangementJson[];
  opaque_events: OpaqueEventJson[];
  score_log: unknown[];
};

// --- Unit normalisation helpers --------------------------------------- //

/**
 * Scale FL's raw 0..255 RGBA byte into Python's 0..1 float space.
 * Divisions are reproduced exactly the way Python's `color` serialiser
 * does (`x / 255` with full float precision); the parity runner uses
 * `1e-4` tolerance to absorb trailing-ULP differences.
 */
function rgbaToJson(c: RGBA | undefined): RgbaJson | null {
  if (c === undefined) return null;
  return {
    _type: "RGBA",
    red: c.r / 255,
    green: c.g / 255,
    blue: c.b / 255,
    alpha: c.a / 255,
  };
}

function pathToJson(value: string | undefined): PathJson | null {
  if (value === undefined) return null;
  return { _type: "path", value };
}

/** Default FL color for freshly-created sampler channels (gray). */
const DEFAULT_CHANNEL_COLOR: RGBA = { r: 65, g: 69, b: 72, a: 0 };

/**
 * Channel plugin projection. VST case (internalName === "Fruity Wrapper")
 * promotes the hosted product name over the wrapper tag — same rule
 * the Python adapter applies.
 */
function pluginToJson(plugin: ChannelPlugin | undefined): PluginJson | null {
  if (plugin === undefined) return null;
  const isVst = plugin.internalName === "Fruity Wrapper";
  const name = isVst && plugin.name !== undefined ? plugin.name : plugin.internalName;
  const vendor = isVst && plugin.vendor !== undefined ? plugin.vendor : null;
  return {
    _type: "Plugin",
    name,
    vendor,
    is_vst: isVst,
    state: null,
  };
}

/**
 * Slot-level plugin projection. VST-hosted slots
 * (`internalName === "Fruity Wrapper"`) promote the wrapper-blob
 * name over the wrapper tag, same rule as channel-hosted VSTs
 * (see `pluginToJson`).
 */
function slotPluginToJson(slot: MixerSlot): PluginJson | null {
  if (!slot.hasPlugin && slot.pluginName === undefined && slot.internalName === undefined) {
    return null;
  }
  const isVst = slot.internalName === "Fruity Wrapper";
  // Python's resolution order for the slot plugin's name:
  //   1. slot display name (`0xCB`, user "rename")
  //   2. VST hosted product name (wrapper blob)
  //   3. internal name (`0xC9`)
  //   4. class-level fallback (for typed plugins we don't mirror)
  //   5. generic plugin-base fallback
  let name = slot.pluginName;
  if (!name && isVst && slot.pluginVstName !== undefined) name = slot.pluginVstName;
  if (!name && slot.internalName !== undefined) name = slot.internalName;
  if (!name) name = "";
  return {
    _type: "Plugin",
    name,
    vendor: isVst ? slot.pluginVendor ?? null : null,
    is_vst: isVst,
    state: null,
  };
}

// --- Entity projectors ------------------------------------------------ //

function toChannel(ch: Channel): ChannelJson {
  // FL default pan/volume when no Levels event: pan=6400 (centre), volume=10000.
  const pan = (ch.levels?.pan ?? 6400) / 6400;
  const volume = (ch.levels?.volume ?? 10000) / 12800;
  return {
    _type: "Channel",
    iid: ch.iid,
    kind: ch.kind,
    name: ch.name ?? null,
    sample_path: pathToJson(ch.sample_path),
    plugin: pluginToJson(ch.plugin),
    color: rgbaToJson(ch.color ?? DEFAULT_CHANNEL_COLOR),
    pan,
    volume,
    enabled: ch.enabled ?? true,
    muted: false, // TS doesn't decode muted yet — Python default
    // the reference parser's `Automation` subclass doesn't expose `.insert`, so
    // `the safe-attr fallback(ch, "insert")` returns None → `target_insert: null`
    // in Python's output. FL still emits a 0x16 event on automation
    // channels with value 0, but Python ignores it. Mirror that.
    target_insert: ch.kind === "automation" ? null : (ch.targetInsert ?? null),
    automation_points: [],
  };
}

function toNote(n: Note): NoteJson {
  return {
    _type: "Note",
    position: n.position,
    length: n.length,
    key: n.key,
    channel_iid: n.channel_iid,
    pan: n.pan,
    velocity: n.velocity,
    fine_pitch: n.fine_pitch,
    release: n.release,
  };
}

function toPattern(p: Pattern): PatternJson {
  return {
    _type: "Pattern",
    iid: p.id,
    name: p.name ?? null,
    color: rgbaToJson(p.color),
    // Python emits null when the pattern-length event isn't present
    // (FL 25 omits `0xA4` for unmodified patterns). Mirror by
    // emitting `null` for undefined.
    length: p.length ?? null,
    looped: p.looped ?? false,
    notes: p.notes.map(toNote),
    controllers: p.controllers.map(() => ({})), // TODO: Controller shape
  };
}

function toMixerSlot(slot: MixerSlot): MixerSlotJson {
  return {
    _type: "MixerSlot",
    index: slot.index,
    // Python defaults to `true` when the MixerParams record isn't present
    // (see `flp_diff/parser.py::_parse_slot` — `bool(the safe-attr fallback(slot,
    // "enabled", True))`). Match.
    enabled: slot.enabled ?? true,
    plugin: slotPluginToJson(slot),
  };
}

function toMixerInsert(ins: MixerInsert): MixerInsertJson {
  return {
    _type: "MixerInsert",
    index: ins.index,
    name: ins.name ?? null,
    color: rgbaToJson(ins.color),
    // The reference adapter returns None when the insert-flags
    // event can't be parsed (e.g., FL 9's 5-byte payload vs the
    // FL 25 12-byte layout). It then coerces via `bool(None) =
    // False`. So on files where our decoder returned undefined —
    // missing or malformed event — both enabled and locked should
    // land as `false`, not the "normal" defaults true/false.
    enabled: ins.flags?.enabled ?? false,
    locked: ins.flags?.locked ?? false,
    // Python's adapter normalises: pan / 6400 clamped [-1, 1],
    // volume / 12800, stereo_separation same as pan.
    pan: ins.pan === undefined ? null : Math.max(-1, Math.min(1, ins.pan / 6400)),
    volume: ins.volume === undefined ? null : ins.volume / 12800,
    stereo_separation:
      ins.stereoSeparation === undefined
        ? null
        : Math.max(-1, Math.min(1, ins.stereoSeparation / 6400)),
    slots: ins.slots.map(toMixerSlot),
    routes_to: [], // TS doesn't decode insert routing matrix yet
  };
}

function toTimeMarker(m: TimeMarker): TimeMarkerJson {
  return {
    _type: "TimeMarker",
    position: m.position,
    name: m.name ?? null,
    numerator: m.numerator ?? null,
    denominator: m.denominator ?? null,
  };
}

function toTrack(t: Arrangement["tracks"][number]): TrackJson {
  return {
    _type: "Track",
    // Python's adapter prefers the decoded iid, falling back to a
    // 1-based enumeration index (our walker stores 0-based, +1
    // here). For default FL 25 tracks the decoded `iid` is 0 and
    // the fallback to index kicks in.
    index: (t.iid && t.iid !== 0) ? t.iid : t.index + 1,
    name: t.name ?? null,
    color: rgbaToJson(t.color),
    // The reference adapter stringifies the raw track height as
    // `str(int(raw*100)) + '%'`, then re-parses "125%" back to 1.25.
    // The int() truncation quantises to 1% increments, so raw
    // 1.0096 → "100%" → 1.0. Apply the same quantisation here.
    height: t.height === undefined ? 1.0 : Math.trunc(t.height * 100) / 100,
    // Python defines `muted` as `not enabled`. Our `enabled` decodes
    // from the track blob byte 12; default when absent is `true` →
    // `muted = false`.
    muted: !(t.enabled ?? true),
    // Per-track playlist items are computed by Python from the
    // track_rvidx → track_idx mapping against the Playlist clips.
    // Our parser keeps clips at the arrangement level (not per
    // track). For now emit [] which matches the default for
    // fresh/empty tracks. TODO: redistribute clips per track when
    // a fixture needs it.
    items: [],
  };
}

function toArrangement(a: Arrangement): ArrangementJson {
  return {
    _type: "Arrangement",
    index: a.id,
    name: a.name ?? null,
    tracks: a.tracks.map(toTrack),
    timemarkers: a.timemarkers.map(toTimeMarker),
  };
}

// --- Metadata --------------------------------------------------------- //

function toMetadata(project: FLPProject, tempo: number): MetadataJson {
  // TODO: decode format/time_signature/main_pitch/main_volume/pan_law.
  // Those emit Python defaults for now so the shape matches and the
  // runner flags drift per-field.
  const m = project.metadata;
  return {
    _type: "ProjectMetadata",
    title: m.title ?? "",
    artists: m.artists ?? "",
    genre: m.genre ?? "",
    comments: m.comments ?? "",
    format: "project",
    ppq: project.header.ppq,
    tempo,
    time_signature: null,
    main_pitch: 0,
    main_volume: null,
    pan_law: 0,
    looped: m.looped ?? false,
    show_info: m.showInfo ?? false,
    url: m.url ?? null,
    data_path: { _type: "path", value: m.dataPath ?? "." },
    created_on: datetimeToJson(m.createdOn),
    time_spent: timedeltaToJson(m.timeSpent),
    version: m.version
      ? { _type: "FLVersion", ...m.version }
      : { _type: "FLVersion", major: 0, minor: 0, patch: 0, build: 0 },
  };
}

function datetimeToJson(d: Date | undefined): DatetimeJson | null {
  if (d === undefined) return null;
  // Python emits a naive local-time ISO like "2026-04-16T17:25:26.422000"
  // (no 'Z', 6 fractional digits). Our Date is UTC-based. The
  // reference timestamp decoder returns *local* datetime — hence
  // Python's ISO has no timezone suffix. We need to match that
  // byte-for-byte.
  //
  // Use the components of the Date in UTC (since we constructed via
  // `Date.UTC(1899, 11, 30) + days*ms` — all UTC), strip 'Z', and pad
  // microseconds to 6 digits for Python's `datetime.isoformat()` format.
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  const ms = pad(d.getUTCMilliseconds(), 3);
  // Python's fractional part is microseconds (6 digits); we have ms
  // precision, zero-pad to match.
  const iso = `${year}-${month}-${day}T${hh}:${mm}:${ss}.${ms}000`;
  return { _type: "datetime", iso };
}

function timedeltaToJson(
  t: { seconds: number } | undefined,
): TimedeltaJson | null {
  if (t === undefined) return null;
  return { _type: "timedelta", seconds: t.seconds };
}

function getTempoFromProject(project: FLPProject): number {
  // Mirror flp-project.ts getTempo but return 120.0 as default rather than
  // undefined (matching what Python does on legacy files with tempo=0).
  const modern = project.events.find((e) => e.kind === "u32" && e.opcode === 0x9c);
  if (modern && modern.kind === "u32") return modern.value / 1000;
  const coarse = project.events.find((e) => e.kind === "u16" && e.opcode === 0x42);
  if (!coarse || coarse.kind !== "u16") return 120.0;
  let tempo = coarse.value;
  const fine = project.events.find((e) => e.kind === "u16" && e.opcode === 0x5d);
  if (fine && fine.kind === "u16") tempo += fine.value / 1000;
  return tempo;
}

// --- Top-level -------------------------------------------------------- //

/**
 * Project a raw `FLPProject` into Python `flp-info --format=json`'s
 * shape. Pure — same input always yields the same output.
 */
export function toFlpInfoJson(project: FLPProject): FlpInfoJson {
  const tempo = getTempoFromProject(project);
  return {
    _type: "FLPProject",
    metadata: toMetadata(project, tempo),
    channels: project.channels.map(toChannel),
    patterns: project.patterns.map(toPattern),
    mixer: {
      _type: "Mixer",
      inserts: project.inserts.map(toMixerInsert),
    },
    arrangements: project.arrangements.map(toArrangement),
    opaque_events: [], // TS doesn't currently classify unknowns as opaque.
    score_log: [],
  };
}
