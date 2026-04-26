/**
 * Deterministic line-oriented canonical text format — git textconv target.
 *
 * Ports Python's `flp_diff.canonical.render_canonical` byte-for-byte.
 * Git calls `flpdiff info --format=canonical` on each side of a diff,
 * captures stdout as the "text" of the FLP, then runs its native
 * line-based diff. For this to produce readable output the canonical
 * text must be:
 *
 *   - Deterministic (byte-identical for identical inputs)
 *   - Line-oriented (one semantic unit per line)
 *   - Stable across small edits (per-entity blocks grouped by identity)
 *   - Low-noise (defaults omitted)
 *
 * Operates on the FlpInfoJson shape so normalised values (pan, volume,
 * color RGBA) match Python's canonical model without a second layer.
 */

import type { FLPProject } from "./parser/flp-project.ts";
import { toFlpInfoJson, type FlpInfoJson } from "./presentation/flp-info.ts";

export const CANONICAL_HEADER = "# flpdiff canonical v1";

type ChannelJson = FlpInfoJson["channels"][number];
type PatternJson = FlpInfoJson["patterns"][number];
type InsertJson = FlpInfoJson["mixer"]["inserts"][number];
type SlotJson = InsertJson["slots"][number];
type ArrJson = FlpInfoJson["arrangements"][number];
type TrackJson = ArrJson["tracks"][number];
type ClipJson = TrackJson["items"][number];
type PluginJson = NonNullable<ChannelJson["plugin"]>;

/**
 * Return the canonical text representation of `project`. Output ends
 * with a trailing newline so shell tools (`diff`, `wc -l`) behave as
 * expected.
 */
export function renderCanonical(project: FLPProject): string {
  const json = toFlpInfoJson(project);
  const lines: string[] = [CANONICAL_HEADER];
  emitMetadata(lines, json.metadata);
  if (json.channels.length > 0) {
    lines.push("");
    lines.push("## channels");
    for (const ch of json.channels) emitChannel(lines, ch);
  }
  if (json.patterns.length > 0) {
    lines.push("");
    lines.push("## patterns");
    for (const p of json.patterns) emitPattern(lines, p);
  }
  if (json.mixer.inserts.length > 0) {
    // Python emits the `## mixer` header whenever the mixer has inserts,
    // even if every insert fails the "interesting" filter (rare — every
    // project has a Master). Mirror that so our header placement matches
    // byte-for-byte even on default-only-inserts files.
    lines.push("");
    lines.push("## mixer");
    for (const ins of json.mixer.inserts) emitMixerInsert(lines, ins);
  }
  if (json.arrangements.length > 0) {
    lines.push("");
    lines.push("## arrangements");
    for (const a of json.arrangements) emitArrangement(lines, a);
  }
  return lines.join("\n") + "\n";
}

// --------------------------------------------------------------------- //
// Formatting primitives                                                 //
// --------------------------------------------------------------------- //

/**
 * Python's `_fmt_float`: N decimal places then strip trailing zeros and
 * the decimal point. `0.500` → `"0.5"`, `1.0` → `"1"`, `120.000` → `"120"`.
 */
function fmtFloat(v: number | null, places = 3): string | null {
  if (v === null || v === undefined) return null;
  let text = v.toFixed(places);
  if (text.includes(".")) {
    text = text.replace(/0+$/, "").replace(/\.$/, "") || "0";
  }
  return text;
}

function fmtColor(c: { red: number; green: number; blue: number; alpha: number } | null): string | null {
  if (c === null) return null;
  const r = Math.round(c.red * 255).toString(16).padStart(2, "0");
  const g = Math.round(c.green * 255).toString(16).padStart(2, "0");
  const b = Math.round(c.blue * 255).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

function fmtPath(p: { _type: "path"; value: string } | null): string | null {
  return p === null ? null : p.value;
}

/**
 * Append `key: value` only when value is meaningful. Skips null, empty
 * string, and empty lists. `0` and `false` are preserved (they're
 * semantically distinct from "unset" for pan / muted / etc.).
 */
function emitKv(lines: string[], key: string, value: unknown, indent = 0): void {
  if (value === null || value === undefined || value === "") return;
  if (Array.isArray(value) && value.length === 0) return;
  const prefix = " ".repeat(indent);
  lines.push(`${prefix}${key}: ${pyRepr(value)}`);
}

/**
 * Python's `str()` for values in key: value lines. Strings are bare
 * (no repr quoting), bools are Python-style ("True"/"False").
 */
function pyRepr(v: unknown): string {
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

function fmtVersion(
  v: { major: number; minor: number; patch: number; build: number | null } | undefined,
): string | null {
  if (v === undefined) return null;
  const parts = [v.major, v.minor, v.patch];
  if (v.build !== null) parts.push(v.build);
  return parts.join(".");
}

// --------------------------------------------------------------------- //
// Section emitters                                                      //
// --------------------------------------------------------------------- //

function emitMetadata(lines: string[], md: FlpInfoJson["metadata"]): void {
  lines.push("");
  lines.push("## metadata");
  emitKv(lines, "format", md.format);
  emitKv(lines, "version", fmtVersion(md.version));
  emitKv(lines, "ppq", md.ppq);
  emitKv(lines, "tempo", fmtFloat(md.tempo, 3));
  if (md.time_signature !== null) {
    emitKv(lines, "time_signature", `${md.time_signature.numerator}/${md.time_signature.denominator}`);
  }
  emitKv(lines, "title", md.title);
  emitKv(lines, "artists", md.artists);
  emitKv(lines, "genre", md.genre);
  emitKv(lines, "comments", md.comments);
  emitKv(lines, "url", md.url);
  emitKv(lines, "data_path", fmtPath(md.data_path));
  // created_on / time_spent intentionally omitted — they churn on every save.
  if (md.looped) lines.push("looped: True");
  if (md.main_pitch) emitKv(lines, "main_pitch", md.main_pitch);
  emitKv(lines, "main_volume", md.main_volume);
  if (md.pan_law) emitKv(lines, "pan_law", md.pan_law);
}

function emitChannel(lines: string[], ch: ChannelJson): void {
  lines.push("");
  lines.push(`### channel ${ch.iid} [${ch.kind}]`);
  emitKv(lines, "name", ch.name);
  emitKv(lines, "color", fmtColor(ch.color));
  if (!ch.enabled) lines.push("disabled: true");
  if (ch.muted) lines.push("muted: true");
  emitKv(lines, "volume", fmtFloat(ch.volume));
  emitKv(lines, "pan", fmtFloat(ch.pan));
  emitKv(lines, "target_insert", ch.target_insert);
  emitKv(lines, "sample_path", fmtPath(ch.sample_path));
  if (ch.plugin !== null) emitPlugin(lines, ch.plugin, "plugin");
}

function emitPlugin(lines: string[], plugin: PluginJson, prefix: string): void {
  lines.push(`${prefix}:`);
  emitKv(lines, "  name", plugin.name);
  emitKv(lines, "  vendor", plugin.vendor);
  if (plugin.is_vst) lines.push("  is_vst: true");
  // Python emits `state_sha256` + `state_size` for OpaqueBlob state and
  // `state.<key>: <val>` for parsed-dict state. TS parser doesn't yet
  // decode plugin state (always null in FlpInfoJson), so nothing to
  // emit here — lines up with Phase 3.4's opaque-changes stub policy.
}

function emitPattern(lines: string[], p: PatternJson): void {
  lines.push("");
  lines.push(`### pattern ${p.iid}`);
  emitKv(lines, "name", p.name);
  emitKv(lines, "color", fmtColor(p.color));
  emitKv(lines, "length", p.length);
  if (p.looped) lines.push("looped: true");
  if (p.notes.length > 0) {
    lines.push(`notes: ${p.notes.length}`);
    for (const n of p.notes) {
      const parts: string[] = [
        `ch=${n.channel_iid}`,
        `pos=${n.position}`,
        `key=${n.key}`,
        `len=${n.length}`,
        `vel=${n.velocity}`,
      ];
      if (n.pan) parts.push(`pan=${n.pan}`);
      if (n.release) parts.push(`rel=${n.release}`);
      if (n.fine_pitch) parts.push(`fp=${n.fine_pitch}`);
      lines.push(`  - note ${parts.join(" ")}`);
    }
  }
  if (p.controllers.length > 0) {
    lines.push(`controllers: ${p.controllers.length}`);
    for (const ap of p.controllers) {
      const parts: string[] = [`pos=${ap.position}`, `val=${fmtFloat(ap.value, 4)}`];
      if (ap.tension) parts.push(`tension=${fmtFloat(ap.tension, 4)}`);
      lines.push(`  - keyframe ${parts.join(" ")}`);
    }
  }
}

/**
 * Python's interestingness heuristic — skip the ~120 empty inserts FL
 * 25 emits by default. An insert counts as "interesting" if anything
 * other than index is set to a non-default value.
 */
function isInterestingInsert(ins: InsertJson): boolean {
  return !(
    !ins.name &&
    ins.color === null &&
    ins.volume === null &&
    ins.pan === null &&
    ins.stereo_separation === null &&
    ins.enabled &&
    !ins.locked &&
    ins.routes_to.length === 0 &&
    !ins.slots.some((s) => s.plugin !== null)
  );
}

function emitMixerInsert(lines: string[], ins: InsertJson): void {
  if (!isInterestingInsert(ins)) return;
  lines.push("");
  lines.push(`### insert ${ins.index}`);
  emitKv(lines, "name", ins.name);
  emitKv(lines, "color", fmtColor(ins.color));
  emitKv(lines, "volume", fmtFloat(ins.volume));
  emitKv(lines, "pan", fmtFloat(ins.pan));
  emitKv(lines, "stereo_separation", fmtFloat(ins.stereo_separation));
  if (!ins.enabled) lines.push("enabled: false");
  if (ins.locked) lines.push("locked: true");
  if (ins.routes_to.length > 0) {
    lines.push(`routes_to: [${ins.routes_to.join(", ")}]`);
  }
  for (const slot of ins.slots) emitSlot(lines, slot);
}

function emitSlot(lines: string[], slot: SlotJson): void {
  // Empty-and-enabled slots are default; skip to reduce noise.
  if (slot.plugin === null && slot.enabled) return;
  lines.push(`slot ${slot.index}:`);
  if (!slot.enabled) lines.push("  enabled: false");
  if (slot.plugin !== null) emitPlugin(lines, slot.plugin, "  plugin");
}

function emitArrangement(lines: string[], arr: ArrJson): void {
  lines.push("");
  lines.push(`### arrangement ${arr.index}`);
  emitKv(lines, "name", arr.name);
  for (const tr of arr.tracks) emitTrack(lines, tr);
  for (const tm of arr.timemarkers) {
    const parts: string[] = [`pos=${tm.position}`];
    if (tm.name) parts.push(`name=${JSON.stringify(tm.name)}`);
    if (tm.numerator !== null && tm.denominator !== null) {
      parts.push(`time_sig=${tm.numerator}/${tm.denominator}`);
    }
    lines.push(`timemarker ${parts.join(" ")}`);
  }
}

/**
 * Python's track filter: skip tracks with no name, no items, no mute,
 * and default height (1.0) — FL 25 emits 500 default tracks per
 * arrangement and rendering every one would dominate the output.
 */
function isInterestingTrack(tr: TrackJson): boolean {
  return !(
    tr.items.length === 0 &&
    !tr.name &&
    !tr.muted &&
    (tr.height === 1.0 || tr.height === undefined)
  );
}

function emitTrack(lines: string[], tr: TrackJson): void {
  if (!isInterestingTrack(tr)) return;
  lines.push("");
  lines.push(`track ${tr.index}:`);
  emitKv(lines, "  name", tr.name);
  emitKv(lines, "  color", fmtColor(tr.color));
  emitKv(lines, "  height", fmtFloat(tr.height));
  if (tr.muted) lines.push("  muted: true");
  for (const item of tr.items) emitPlaylistItem(lines, item);
}

function emitPlaylistItem(lines: string[], item: ClipJson): void {
  const parts: string[] = [`pos=${item.position}`, `len=${item.length}`];
  if (item.pattern_iid !== null) parts.push(`pattern=${item.pattern_iid}`);
  if (item.channel_iid !== null) parts.push(`channel=${item.channel_iid}`);
  if (item.muted) parts.push("muted");
  lines.push(`  - clip ${parts.join(" ")}`);
}
