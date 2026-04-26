/**
 * Human-readable single-file inspection report — `flpdiff info <file>`.
 *
 * Ports Python's `flp_diff.cli.render_info` byte-for-byte. Format:
 *
 *   File: <filename>
 *   FL Studio <version> | <tempo> BPM | <time sig> | PPQ <ppq>
 *   [Title: <title>]       (omitted if unset/empty)
 *   [Artists: <artists>]
 *   [Genre: <genre>]
 *   Channels: <N> (<K1> <kind1>s, <K2> <kind2>s, …)
 *   Patterns: <N>
 *   Mixer: <active-inserts> active inserts, <slots> effect slots
 *   Arrangements: <N> (<tracks> tracks, <clips> clips)
 *   Plugins: <csv-list> [… and N more]
 *   Samples: <filename-csv-list>
 *
 * The JSON format bypasses this renderer entirely and uses the
 * presentation layer's `toFlpInfoJson` — see `src/presentation/flp-info.ts`.
 */

import { basename } from "node:path";
import type { FLPProject } from "./parser/flp-project.ts";
import type { Channel } from "./model/channel.ts";
import type { MixerInsert } from "./model/mixer-insert.ts";

function countChannelsByKind(channels: readonly Channel[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ch of channels) counts[ch.kind] = (counts[ch.kind] ?? 0) + 1;
  return counts;
}

/** Python's `_active_inserts`: any insert with slots, a name, or routes_to. */
function activeInserts(inserts: readonly MixerInsert[]): MixerInsert[] {
  return inserts.filter((ins) => ins.slots.length > 0 || ins.name !== undefined);
}

/** Python's `_effect_slot_count`: slots across all inserts where plugin is not null. */
function effectSlotCount(inserts: readonly MixerInsert[]): number {
  let n = 0;
  for (const ins of inserts) {
    for (const s of ins.slots) if (s.hasPlugin === true || s.pluginName) n++;
  }
  return n;
}

/**
 * Collect plugin display names across channels + mixer slots, dedup in
 * insertion order. Matches Python's `_collect_plugin_names` via
 * `dict.setdefault(name, None)`.
 */
function collectPluginNames(project: FLPProject): string[] {
  const seen = new Map<string, null>();
  for (const ch of project.channels) {
    const p = ch.plugin;
    if (p) {
      // Python's canonical `Plugin.name` is what `pluginDisplayLabel`
      // uses — VST real name if available, else the internal name.
      const name = p.name ?? p.internalName;
      if (name) seen.set(name, null);
    }
  }
  for (const ins of project.inserts) {
    for (const s of ins.slots) {
      const name = s.pluginVstName ?? s.pluginName ?? s.internalName;
      if (name) seen.set(name, null);
    }
  }
  return Array.from(seen.keys());
}

function collectSamplePaths(project: FLPProject): string[] {
  const seen = new Map<string, null>();
  for (const ch of project.channels) {
    if (ch.sample_path !== undefined && ch.sample_path !== "") {
      seen.set(ch.sample_path, null);
    }
  }
  return Array.from(seen.keys());
}

function fmtTimeSig(
  num: number | undefined,
  denom: number | undefined,
): string {
  if (num === undefined || denom === undefined) return "?";
  return `${num}/${denom}`;
}

function fmtChannelKinds(counts: Record<string, number>): string {
  const keys = Object.keys(counts);
  if (keys.length === 0) return "0";
  const total = keys.reduce((n, k) => n + counts[k]!, 0);
  // Sort alphabetically to match Python's `sorted(counts.items())`.
  const sortedKeys = [...keys].sort();
  const parts = sortedKeys.map((k) => {
    const n = counts[k]!;
    return `${n} ${k}${n !== 1 ? "s" : ""}`;
  });
  return `${total} (${parts.join(", ")})`;
}

function fmtList(values: readonly string[], maxItems: number): string {
  if (values.length === 0) return "(none)";
  if (values.length <= maxItems) return values.join(", ");
  const shown = values.slice(0, maxItems).join(", ");
  return `${shown}, … and ${values.length - maxItems} more`;
}

function pythonFloatOneDp(n: number): string {
  // Python's `f"{n:.1f}"`. JS `.toFixed(1)` matches — rounds half-up but
  // that's the same behavior Python uses for format-string floats (it's
  // NOT banker's rounding there; only `round()` is banker's). Spot-check
  // against Python in tests.
  return n.toFixed(1);
}

function fmtVersion(
  v: { major: number; minor: number; patch: number; build: number | null } | undefined,
): string {
  if (v === undefined) return "?";
  const parts = [v.major, v.minor, v.patch];
  if (v.build !== null) parts.push(v.build);
  return parts.join(".");
}

/**
 * Render a human-readable inspection report. Mirrors Python's
 * `render_info(project, file)` output exactly.
 */
export function renderInfo(project: FLPProject, filePath: string): string {
  const md = project.metadata;
  const channelsByKind = countChannelsByKind(project.channels);
  const active = activeInserts(project.inserts);
  const slots = effectSlotCount(project.inserts);
  const pluginNames = collectPluginNames(project);
  const sampleNames = collectSamplePaths(project).map((p) => {
    const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return idx < 0 ? p : p.substring(idx + 1);
  });

  const tracksTotal = project.arrangements.reduce((n, a) => n + a.tracks.length, 0);
  const clipsTotal = project.arrangements.reduce(
    (n, a) => n + a.tracks.reduce((m, t) => m, 0) + a.clips.length,
    0,
  );

  const lines: string[] = [];
  lines.push(`File: ${basename(filePath)}`);
  lines.push(
    `FL Studio ${fmtVersion(md.version)}` +
      ` | ${pythonFloatOneDp(getTempoOrZero(project))} BPM` +
      ` | ${fmtTimeSig(md.timeSignatureNumerator, md.timeSignatureDenominator)}` +
      ` | PPQ ${project.header.ppq}`,
  );
  if (md.title) lines.push(`Title: ${md.title}`);
  if (md.artists) lines.push(`Artists: ${md.artists}`);
  if (md.genre) lines.push(`Genre: ${md.genre}`);
  lines.push(`Channels: ${fmtChannelKinds(channelsByKind)}`);
  lines.push(`Patterns: ${project.patterns.length}`);
  lines.push(`Mixer: ${active.length} active inserts, ${slots} effect slots`);
  lines.push(`Arrangements: ${project.arrangements.length} (${tracksTotal} tracks, ${clipsTotal} clips)`);
  lines.push(`Plugins: ${fmtList(pluginNames, 8)}`);
  lines.push(`Samples: ${fmtList(sampleNames, 8)}`);
  return lines.join("\n");
}

function getTempoOrZero(project: FLPProject): number {
  // Mirror Python's `md.tempo` — flp_diff.ProjectMetadata.tempo is a
  // float populated from the raw FLP. Our TS metadata doesn't store a
  // top-level tempo yet; derive from events via the same path Python
  // uses. Returns 0.0 if no tempo event found (pre-FL-3.4 + no 0x42).
  const modern = project.events.find((e) => e.kind === "u32" && e.opcode === 0x9c);
  if (modern && modern.kind === "u32") return modern.value / 1000;
  const coarse = project.events.find((e) => e.kind === "u16" && e.opcode === 0x42);
  if (!coarse || coarse.kind !== "u16") return 0;
  let tempo = coarse.value;
  const fine = project.events.find((e) => e.kind === "u16" && e.opcode === 0x5d);
  if (fine && fine.kind === "u16") tempo += fine.value / 1000;
  return tempo;
}
