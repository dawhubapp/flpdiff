/**
 * Property-level diff for matched entity pairs. Ports
 * `flp_diff.comparator` — metadata + channel scalars + plugin identity
 * in this first wave; note diff, automation diff, mixer insert diff,
 * and clip-collapse grouping land in subsequent commits.
 *
 * Architecture: the comparator operates on the **canonical normalized
 * JSON shape** produced by `toFlpInfoJson` (pan as -1..1 float, volume
 * as 0..1 float, color as 0..1 RGBA, etc.) rather than on the raw
 * `FLPProject`. This is the same shape Python's comparator sees,
 * so label strings come out byte-equivalent without a separate
 * normalization layer.
 *
 * The top-level orchestrator accepts two raw `FLPProject`s and
 * internally projects via `toFlpInfoJson`.
 */

import { toFlpInfoJson, type FlpInfoJson } from "../presentation/flp-info.ts";
import type { FLPProject } from "../parser/flp-project.ts";
import {
  makeChange,
  makeChannelDiff,
  type Change,
  type ChangeKind,
  type ChannelDiff,
} from "./diff-model.ts";
import { pairByKey, type Match } from "./matcher.ts";
import { compareMixerFromJson } from "./mixer-diff.ts";

// --------------------------------------------------------------------- //
// Formatting primitives — must match Python's output byte-for-byte     //
// --------------------------------------------------------------------- //

/** Scalar change kind from old/new pair. `null` means "absent". */
export function classify(oldVal: unknown, newVal: unknown): ChangeKind {
  if (oldVal === null && newVal !== null) return "added";
  if (oldVal !== null && newVal === null) return "removed";
  return "modified";
}

/**
 * Render `null`/`undefined` as `"unset"` and everything else via
 * Python's `repr()`. String `"foo"` → `"'foo'"`, empty string → `"''"`,
 * bool → `"True"`/`"False"`, int stays bare, float always shows a
 * decimal point (`"120.0"`). Only used when the caller doesn't know
 * the value's static type — for numeric fields with known float-vs-int
 * semantics (tempo, ppq), prefer `pythonFloatRepr` / `pythonIntRepr`.
 */
export function fmtNoneFriendly(value: unknown): string {
  if (value === null || value === undefined) return "unset";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  return String(value);
}

/**
 * Python's `repr(float)` — whole-number floats show `.0`, others show
 * the natural decimal string. Used for fields whose Python type is
 * `float`: tempo (BPM), normalized volume/pan (0..1, -1..1), etc.
 */
export function pythonFloatRepr(n: number): string {
  const s = String(n);
  // If already has `.` or exponent, return as-is; else append `.0`.
  if (s.includes(".") || s.includes("e") || s.includes("E")) return s;
  return `${s}.0`;
}

/** Python: `"unset" if v is None else f"{round(v * 100)}%"` */
export function fmtPct(v: number | null): string {
  if (v === null || v === undefined) return "unset";
  return `${pythonRound(v * 100)}%`;
}

/** Python: "centered" | `"${pct}% L"` | `"${pct}% R"` | "unset" */
export function fmtPan(v: number | null): string {
  if (v === null || v === undefined) return "unset";
  if (Math.abs(v) < 1e-6) return "centered";
  const side = v < 0 ? "L" : "R";
  return `${pythonRound(Math.abs(v) * 100)}% ${side}`;
}

/** `unset` | `"4/4"` */
export function fmtTimeSig(ts: { numerator: number; denominator: number } | null): string {
  if (ts === null || ts === undefined) return "unset";
  return `${ts.numerator}/${ts.denominator}`;
}

/** `on` | `off` */
export function fmtBool(v: boolean): string {
  return v ? "on" : "off";
}

/**
 * Python's round-half-to-even (banker's rounding). JS `Math.round`
 * rounds half up (0.5 → 1); Python rounds 0.5 → 0, 1.5 → 2.
 * Duplicated from model/channel.ts to avoid a cross-module import.
 */
function pythonRound(x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (frac < 0.5) return floor;
  if (frac > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Render an RGBA JSON value as `#rrggbb` (alpha dropped), matching
 * Python's `RGBA.to_hex()`. `round(c * 255)` uses banker's rounding
 * on the Python side — mirrored via `pythonRound`.
 */
export function colorHex(
  c: { red: number; green: number; blue: number; alpha: number } | null,
): string {
  if (c === null) return "unset";
  const r = pythonRound(c.red * 255).toString(16).padStart(2, "0");
  const g = pythonRound(c.green * 255).toString(16).padStart(2, "0");
  const b = pythonRound(c.blue * 255).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

// --------------------------------------------------------------------- //
// Scalar-field helper                                                   //
// --------------------------------------------------------------------- //

/** Emit a Change if oldVal != newVal (deep-equal for objects), else null. */
export function scalarChange(
  path: string,
  oldVal: unknown,
  newVal: unknown,
  humanLabel: string,
): Change | null {
  if (deepEqual(oldVal, newVal)) return null;
  return makeChange({
    path,
    kind: classify(oldVal, newVal),
    oldValue: oldVal,
    newValue: newVal,
    humanLabel,
  });
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

// --------------------------------------------------------------------- //
// Metadata comparison                                                   //
// --------------------------------------------------------------------- //

/**
 * Diff two metadata records field-by-field. Mirrors Python's
 * `compare_metadata`. `version`, `created_on` and `time_spent` are
 * intentionally skipped:
 *   - version always changes when FL versions differ; exposed in summary.
 *   - created_on is constant for the project's life.
 *   - time_spent ticks on every save — perpetual noise.
 */
export function compareMetadata(
  oldMeta: FlpInfoJson["metadata"],
  newMeta: FlpInfoJson["metadata"],
): Change[] {
  const changes: Change[] = [];
  const base = "metadata";

  const push = (c: Change | null) => {
    if (c !== null) changes.push(c);
  };

  // Tempo — numeric with direction phrasing. Tempo is a float in
  // Python, so whole-number BPMs render as `120.0` (not `120`).
  if (oldMeta.tempo !== newMeta.tempo) {
    const delta = newMeta.tempo - oldMeta.tempo;
    const direction = delta > 0 ? "increased" : "decreased";
    const label = `Tempo ${direction} from ${pythonFloatRepr(oldMeta.tempo)} to ${pythonFloatRepr(newMeta.tempo)} BPM`;
    push(
      makeChange({
        path: `${base}.tempo`,
        kind: "modified",
        oldValue: oldMeta.tempo,
        newValue: newMeta.tempo,
        humanLabel: label,
      }),
    );
  }

  // Time signature — both null on every current TS/Python fixture; logic
  // kept for forward compatibility when a future decoder surfaces it.
  if (!deepEqual(oldMeta.time_signature, newMeta.time_signature)) {
    const ov = unwrapTs(oldMeta.time_signature);
    const nv = unwrapTs(newMeta.time_signature);
    const label = `Time signature changed from ${fmtTimeSig(ov)} to ${fmtTimeSig(nv)}`;
    push(
      makeChange({
        path: `${base}.time_signature`,
        kind: classify(oldMeta.time_signature, newMeta.time_signature),
        oldValue: oldMeta.time_signature,
        newValue: newMeta.time_signature,
        humanLabel: label,
      }),
    );
  }

  if (oldMeta.ppq !== newMeta.ppq) {
    push(scalarChange(`${base}.ppq`, oldMeta.ppq, newMeta.ppq, `PPQ changed from ${oldMeta.ppq} to ${newMeta.ppq}`));
  }

  // String fields — empty-string counts as "present but empty", distinct
  // from null (absent). Python treats these symmetrically via != .
  const stringFields: [keyof FlpInfoJson["metadata"], string][] = [
    ["title", "Title"],
    ["artists", "Artists"],
    ["genre", "Genre"],
    ["comments", "Comments"],
    ["url", "URL"],
  ];
  for (const [field, labelVerb] of stringFields) {
    const ov = oldMeta[field];
    const nv = newMeta[field];
    if (ov === nv) continue;
    // Python uses `!r` (repr): empty strings render as `''`, not
    // `"unset"`. Only `None` goes to `"unset"`. Our JSON carries these
    // as strings never-null, but keep the null path for metadata
    // fields that are nullable (url, data_path).
    push(
      makeChange({
        path: `${base}.${field}`,
        kind: classify(ov ?? null, nv ?? null),
        oldValue: ov,
        newValue: nv,
        humanLabel: `${labelVerb}: ${fmtNoneFriendly(ov)} → ${fmtNoneFriendly(nv)}`,
      }),
    );
  }

  // data_path — a PathJson wrapper `{_type: "path", value}`.
  // Python renders via `str(old.data_path) if old.data_path else None`,
  // then passes through `_fmt_none_friendly`: None → "unset", else
  // `'<path>'`. An empty-value path wrapper would render as `''`.
  if (!deepEqual(oldMeta.data_path, newMeta.data_path)) {
    const ov = oldMeta.data_path?.value ?? null;
    const nv = newMeta.data_path?.value ?? null;
    push(
      makeChange({
        path: `${base}.data_path`,
        kind: classify(oldMeta.data_path, newMeta.data_path),
        oldValue: oldMeta.data_path,
        newValue: newMeta.data_path,
        humanLabel: `Data path: ${fmtNoneFriendly(ov)} → ${fmtNoneFriendly(nv)}`,
      }),
    );
  }

  // Booleans + numeric scalars.
  if (oldMeta.looped !== newMeta.looped) {
    push(
      scalarChange(
        `${base}.looped`,
        oldMeta.looped,
        newMeta.looped,
        `Loop playback ${fmtBool(newMeta.looped)} (was ${fmtBool(oldMeta.looped)})`,
      ),
    );
  }
  if (oldMeta.main_pitch !== newMeta.main_pitch) {
    push(
      scalarChange(
        `${base}.main_pitch`,
        oldMeta.main_pitch,
        newMeta.main_pitch,
        `Main pitch changed from ${oldMeta.main_pitch} to ${newMeta.main_pitch}`,
      ),
    );
  }
  if (oldMeta.main_volume !== newMeta.main_volume) {
    push(
      scalarChange(
        `${base}.main_volume`,
        oldMeta.main_volume,
        newMeta.main_volume,
        `Main volume: ${fmtNoneFriendly(oldMeta.main_volume)} → ${fmtNoneFriendly(newMeta.main_volume)}`,
      ),
    );
  }
  if (oldMeta.pan_law !== newMeta.pan_law) {
    push(
      scalarChange(
        `${base}.pan_law`,
        oldMeta.pan_law,
        newMeta.pan_law,
        `Pan law changed from ${oldMeta.pan_law} to ${newMeta.pan_law}`,
      ),
    );
  }
  if (oldMeta.show_info !== newMeta.show_info) {
    push(
      scalarChange(
        `${base}.show_info`,
        oldMeta.show_info,
        newMeta.show_info,
        `Show-info ${fmtBool(newMeta.show_info)} (was ${fmtBool(oldMeta.show_info)})`,
      ),
    );
  }

  return changes;
}

function unwrapTs(
  ts: { _type: "TimeSignature"; numerator: number; denominator: number } | null,
): { numerator: number; denominator: number } | null {
  if (ts === null) return null;
  return { numerator: ts.numerator, denominator: ts.denominator };
}

// --------------------------------------------------------------------- //
// Channel comparison                                                    //
// --------------------------------------------------------------------- //

type ChannelJson = FlpInfoJson["channels"][number];
type PluginJson = NonNullable<ChannelJson["plugin"]>;

/**
 * Short "kind 'name'" label for entity header and plugin state location.
 * Python: `_channel_label`. For unnamed channels falls back to `#<iid>`.
 */
function channelLabel(ch: ChannelJson): string {
  const name = ch.name ?? `#${ch.iid}`;
  return `${ch.kind} '${name}'`;
}

/**
 * Variant for added/removed channel labels. A sampler's sample path is
 * its most identifying property — same display name might attach to
 * entirely different samples across saves. Instrument / automation /
 * layer channels (no sample_path) fall back to the terse form.
 */
function channelLabelWithSample(ch: ChannelJson): string {
  const base = channelLabel(ch);
  if (ch.sample_path === null) return base;
  return `${base} (sample: ${ch.sample_path.value})`;
}

/**
 * Render a plugin identity the way a user would say it out loud.
 *
 *   - VSTs with vendor: `"'Serum' (Xfer Records, VST)"`.
 *   - VSTs without vendor: `"'Serum' (VST)"`.
 *   - Native FL plugins: the name alone (`"Fruity Limiter"`).
 */
function pluginDisplayLabel(p: PluginJson): string {
  const name = p.name || "unknown plugin";
  if (p.is_vst) {
    if (p.vendor) return `'${name}' (${p.vendor}, VST)`;
    return `'${name}' (VST)`;
  }
  return name;
}

/**
 * Compare two plugin JSON objects at `pathPrefix`. Returns the scalar
 * Changes; the opaque-state branch (Python's `_plugin_state_opaque_change`)
 * is stubbed until Phase 3.4.2e. Plugin state parsing isn't in scope for
 * this commit.
 *
 * Dedupe rule (mirrors Python): when the plugin name changes the slot
 * is effectively a different plugin; vendor/is_vst changes suppress
 * because `pluginDisplayLabel` already embeds them in the swap label.
 */
export function comparePluginLabels(
  pathPrefix: string,
  oldP: PluginJson | null,
  newP: PluginJson | null,
  slotHint = "",
): Change[] {
  return comparePlugin(pathPrefix, oldP, newP, slotHint);
}

function comparePlugin(
  pathPrefix: string,
  oldP: PluginJson | null,
  newP: PluginJson | null,
  slotHint = "",
): Change[] {
  const out: Change[] = [];
  if (oldP === null && newP === null) return out;
  if (oldP === null) {
    out.push(
      makeChange({
        path: pathPrefix,
        kind: "added",
        oldValue: null,
        newValue: newP,
        humanLabel: `Plugin added${slotHint}: ${pluginDisplayLabel(newP!)}`,
      }),
    );
    return out;
  }
  if (newP === null) {
    out.push(
      makeChange({
        path: pathPrefix,
        kind: "removed",
        oldValue: oldP,
        newValue: null,
        humanLabel: `Plugin removed${slotHint}: ${pluginDisplayLabel(oldP)}`,
      }),
    );
    return out;
  }

  if (oldP.name !== newP.name) {
    out.push(
      makeChange({
        path: `${pathPrefix}.name`,
        kind: "modified",
        oldValue: oldP.name,
        newValue: newP.name,
        humanLabel: `Plugin swapped${slotHint}: ${pluginDisplayLabel(oldP)} → ${pluginDisplayLabel(newP)}`,
      }),
    );
  } else {
    // Same plugin: vendor/is_vst are genuinely independent signals.
    if (oldP.vendor !== newP.vendor) {
      out.push(
        makeChange({
          path: `${pathPrefix}.vendor`,
          kind: classify(oldP.vendor, newP.vendor),
          oldValue: oldP.vendor,
          newValue: newP.vendor,
          humanLabel: `Plugin vendor${slotHint}: ${fmtNoneFriendly(oldP.vendor)} → ${fmtNoneFriendly(newP.vendor)}`,
        }),
      );
    }
    if (oldP.is_vst !== newP.is_vst) {
      out.push(
        makeChange({
          path: `${pathPrefix}.is_vst`,
          kind: "modified",
          oldValue: oldP.is_vst,
          newValue: newP.is_vst,
          humanLabel: `Plugin hosting${slotHint} changed: ${newP.is_vst ? "VST" : "native"}`,
        }),
      );
    }
  }

  return out;
}

/**
 * Produce a `ChannelDiff` for one matched (or unmatched) pair. Scalar
 * properties only in this commit — automation-points diff and opaque
 * plugin-state land in 3.4.2d / 3.4.2e respectively.
 */
export function compareChannel(match: Match<ChannelJson>): ChannelDiff {
  if (match.old === null && match.new !== null) {
    return makeChannelDiff({
      identity: ["channel", match.new.iid],
      kind: "added",
      name: match.new.name,
      humanLabel: `Added channel ${channelLabelWithSample(match.new)}`,
    });
  }
  if (match.old !== null && match.new === null) {
    return makeChannelDiff({
      identity: ["channel", match.old.iid],
      kind: "removed",
      name: match.old.name,
      humanLabel: `Removed channel ${channelLabelWithSample(match.old)}`,
    });
  }

  const oldCh = match.old!;
  const newCh = match.new!;
  const path = `channels[${oldCh.iid}]`;
  const changes: Change[] = [];
  const push = (c: Change | null) => {
    if (c !== null) changes.push(c);
  };

  if (oldCh.kind !== newCh.kind) {
    push(scalarChange(`${path}.kind`, oldCh.kind, newCh.kind, `Channel type changed from ${oldCh.kind} to ${newCh.kind}`));
  }
  if (oldCh.name !== newCh.name) {
    push(
      scalarChange(
        `${path}.name`,
        oldCh.name,
        newCh.name,
        `Channel renamed from ${fmtNoneFriendly(oldCh.name)} to ${fmtNoneFriendly(newCh.name)}`,
      ),
    );
  }
  if (!deepEqual(oldCh.color, newCh.color)) {
    push(
      scalarChange(
        `${path}.color`,
        oldCh.color,
        newCh.color,
        `Channel color: ${colorHex(oldCh.color)} → ${colorHex(newCh.color)}`,
      ),
    );
  }
  if (oldCh.enabled !== newCh.enabled) {
    push(
      scalarChange(
        `${path}.enabled`,
        oldCh.enabled,
        newCh.enabled,
        `Channel ${fmtBool(newCh.enabled)} (was ${fmtBool(oldCh.enabled)})`,
      ),
    );
  }
  if (oldCh.muted !== newCh.muted) {
    push(
      scalarChange(
        `${path}.muted`,
        oldCh.muted,
        newCh.muted,
        `Channel ${newCh.muted ? "muted" : "unmuted"}`,
      ),
    );
  }
  if (oldCh.volume !== newCh.volume) {
    push(
      scalarChange(
        `${path}.volume`,
        oldCh.volume,
        newCh.volume,
        `Channel volume ${fmtPct(oldCh.volume)} → ${fmtPct(newCh.volume)}`,
      ),
    );
  }
  if (oldCh.pan !== newCh.pan) {
    push(
      scalarChange(
        `${path}.pan`,
        oldCh.pan,
        newCh.pan,
        `Channel pan ${fmtPan(oldCh.pan)} → ${fmtPan(newCh.pan)}`,
      ),
    );
  }
  if (oldCh.target_insert !== newCh.target_insert) {
    push(
      scalarChange(
        `${path}.target_insert`,
        oldCh.target_insert,
        newCh.target_insert,
        `Channel routed to insert ${fmtNoneFriendly(newCh.target_insert)} (was ${fmtNoneFriendly(oldCh.target_insert)})`,
      ),
    );
  }
  if (!deepEqual(oldCh.sample_path, newCh.sample_path)) {
    const ov = oldCh.sample_path?.value ?? null;
    const nv = newCh.sample_path?.value ?? null;
    push(
      scalarChange(
        `${path}.sample_path`,
        oldCh.sample_path,
        newCh.sample_path,
        `Sample path: ${fmtNoneFriendly(ov)} → ${fmtNoneFriendly(nv)}`,
      ),
    );
  }

  const pluginChanges = comparePlugin(`${path}.plugin`, oldCh.plugin, newCh.plugin);
  changes.push(...pluginChanges);

  // Python uses "changes" (plural) always, even for count=1. Mirror.
  const nTotal = changes.length;
  const label =
    nTotal > 0
      ? `Channel ${channelLabel(oldCh)} modified (${nTotal} changes)`
      : `Channel ${channelLabel(oldCh)} unchanged`;

  return makeChannelDiff({
    identity: ["channel", oldCh.iid],
    kind: "modified",
    name: oldCh.name,
    humanLabel: label,
    changes,
  });
}

// --------------------------------------------------------------------- //
// High-level entry points (JSON-level)                                  //
// --------------------------------------------------------------------- //

/**
 * Compare two projects at the **FlpInfoJson** level. This is the
 * canonical normalized shape Python's comparator also sees, so human
 * labels match byte-for-byte when both sides receive equivalent inputs.
 *
 * Current scope: metadata + channel scalars + plugin identity. Note
 * diff, automation diff, mixer-insert diff, arrangement diff, and
 * clip-collapse grouping land in subsequent commits.
 */
export function compareProjectsJson(
  oldJson: FlpInfoJson,
  newJson: FlpInfoJson,
): {
  metadataChanges: Change[];
  channelChanges: ChannelDiff[];
  mixerChanges: import("./diff-model.ts").MixerDiff;
} {
  const metadataChanges = compareMetadata(oldJson.metadata, newJson.metadata);

  // Match on the same semantics as matchChannels (primary iid, secondary
  // "kind\x00name" with kind guard), but operate on ChannelJson.
  const channelMatches = pairByKey(
    oldJson.channels,
    newJson.channels,
    (c) => c.iid,
    (c) => (c.name ? `${c.kind}\x00${c.name}` : undefined),
  );
  const channelChanges: ChannelDiff[] = [];
  for (const m of channelMatches) {
    const diff = compareChannel(m);
    if (diff.kind === "modified" && diff.changes.length === 0) continue;
    channelChanges.push(diff);
  }

  const mixerChanges = compareMixerFromJson(oldJson.mixer.inserts, newJson.mixer.inserts);

  return { metadataChanges, channelChanges, mixerChanges };
}

/**
 * Raw-FLPProject entry point. Projects both sides through `toFlpInfoJson`
 * and delegates to `compareProjectsJson`. This is the typical entry
 * point — users start with `parseFLPFile` → two FLPProjects → diff.
 */
export function compareProjects(
  oldProj: FLPProject,
  newProj: FLPProject,
): {
  metadataChanges: Change[];
  channelChanges: ChannelDiff[];
  mixerChanges: import("./diff-model.ts").MixerDiff;
} {
  return compareProjectsJson(toFlpInfoJson(oldProj), toFlpInfoJson(newProj));
}
