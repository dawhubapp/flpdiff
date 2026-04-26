/**
 * Human-readable diff summary renderer. Ports `flp_diff.summary`
 * exactly — same section ordering, same markers (`+`/`-`/`~`), same
 * indentation, same note-bucket summarization rule (≤10 notes shown
 * verbatim, otherwise kind-grouped with first-3 examples each).
 *
 * Pure text — no ANSI colors, no TTY assumptions. A future color
 * formatter (analogous to Python's flp_diff.formatters.text) can wrap
 * this output; the JSON formatter serializes DiffResult directly and
 * bypasses this module entirely.
 */

import type {
  ArrangementDiff,
  Change,
  ChannelDiff,
  DiffResult,
  MixerDiff,
  MixerInsertDiff,
  NoteChange,
  OpaqueChange,
  PatternDiff,
  TrackDiff,
  AutomationChange,
} from "./diff-model.ts";
import { diffResultIsIdentical, isMixerDiffEmpty } from "./diff-model.ts";

const ADDED = "+";
const REMOVED = "-";
const MODIFIED = "~";

export type RenderSummaryOptions = {
  /**
   * Optional header line. Typical callers pass the filenames being
   * compared (`"my_track_v2.flp vs my_track_v1.flp"`).
   */
  title?: string;
  /**
   * When true, clip-move / clip-bulk / clip-modify groups expand back
   * to one line per clip. Useful for --verbose CLI mode.
   */
  verbose?: boolean;
};

/**
 * Produce a multi-line text summary from `result`. Mirrors Python's
 * `flp_diff.summary.render_summary` byte-for-byte.
 */
export function renderSummary(result: DiffResult, options: RenderSummaryOptions = {}): string {
  const { title, verbose = false } = options;
  const lines: string[] = [];

  if (title) {
    const header = `FLP Diff: ${title}`;
    lines.push(header);
    // Python uses U+2500 (BOX DRAWINGS LIGHT HORIZONTAL) ×
    // min(len(header), 60). Use the same character.
    const width = Math.min(header.length, 60);
    lines.push("─".repeat(width));
  }

  lines.push(`Summary: ${result.summary.humanLabel}`);
  if (diffResultIsIdentical(result)) return lines.join("\n");

  if (result.metadataChanges.length > 0) emitMetadata(lines, result.metadataChanges);
  if (result.channelChanges.length > 0) emitChannels(lines, result.channelChanges);
  if (result.patternChanges.length > 0) emitPatterns(lines, result.patternChanges);
  if (!isMixerDiffEmpty(result.mixerChanges)) emitMixer(lines, result.mixerChanges);
  if (result.arrangementChanges.length > 0) emitArrangements(lines, result.arrangementChanges, verbose);
  if (result.opaqueChanges.length > 0) emitOpaques(lines, result.opaqueChanges);

  return lines.join("\n");
}

// --------------------------------------------------------------------- //
// Marker helpers                                                        //
// --------------------------------------------------------------------- //

function marker(kind: string): string {
  if (kind === "added") return ADDED;
  if (kind === "removed") return REMOVED;
  return MODIFIED;
}

function changeMarker(change: Change | NoteChange | AutomationChange): string {
  return marker(change.kind);
}

// --------------------------------------------------------------------- //
// Section emitters                                                      //
// --------------------------------------------------------------------- //

function sectionHeader(lines: string[], title: string): void {
  lines.push("");
  lines.push(`${title}:`);
}

function emitMetadata(lines: string[], changes: readonly Change[]): void {
  sectionHeader(lines, "Metadata");
  for (const c of changes) lines.push(`  ${changeMarker(c)} ${c.humanLabel}`);
}

function emitChannels(lines: string[], diffs: readonly ChannelDiff[]): void {
  sectionHeader(lines, "Channels");
  for (const d of diffs) {
    lines.push(`  ${marker(d.kind)} ${d.humanLabel}`);
    for (const c of d.changes) lines.push(`      ${changeMarker(c)} ${c.humanLabel}`);
    for (const ac of d.automationChanges) lines.push(`      ${marker(ac.kind)} ${ac.humanLabel}`);
  }
}

function emitPatterns(lines: string[], diffs: readonly PatternDiff[]): void {
  sectionHeader(lines, "Patterns");
  for (const d of diffs) {
    lines.push(`  ${marker(d.kind)} ${d.humanLabel}`);
    for (const c of d.changes) lines.push(`      ${changeMarker(c)} ${c.humanLabel}`);
    if (d.noteChanges.length > 0) emitNoteChanges(lines, d.noteChanges);
    for (const ac of d.controllerChanges) lines.push(`      ${marker(ac.kind)} ${ac.humanLabel}`);
  }
}

const MAX_VERBATIM_NOTES = 10;
const EXAMPLES_PER_KIND = 3;

function emitNoteChanges(lines: string[], notes: readonly NoteChange[]): void {
  if (notes.length <= MAX_VERBATIM_NOTES) {
    for (const nc of notes) lines.push(`      ${marker(nc.kind)} ${nc.humanLabel}`);
    return;
  }
  const byKind: Record<string, NoteChange[]> = {};
  for (const nc of notes) {
    (byKind[nc.kind] ??= []).push(nc);
  }
  for (const kind of ["modified", "moved", "removed", "added"] as const) {
    const bucket = byKind[kind] ?? [];
    if (bucket.length === 0) continue;
    lines.push(`      ${marker(kind)} ${bucket.length} notes ${kind}`);
    for (const nc of bucket.slice(0, EXAMPLES_PER_KIND)) {
      lines.push(`          · ${nc.humanLabel}`);
    }
    if (bucket.length > EXAMPLES_PER_KIND) {
      lines.push(`          · … and ${bucket.length - EXAMPLES_PER_KIND} more`);
    }
  }
}

function emitMixer(lines: string[], mixer: MixerDiff): void {
  sectionHeader(lines, "Mixer");
  for (const d of mixer.inserts) emitMixerInsert(lines, d);
  for (const c of mixer.changes) lines.push(`  ${changeMarker(c)} ${c.humanLabel}`);
}

function emitMixerInsert(lines: string[], d: MixerInsertDiff): void {
  lines.push(`  ${marker(d.kind)} ${d.humanLabel}`);
  for (const c of d.changes) lines.push(`      ${changeMarker(c)} ${c.humanLabel}`);
}

function emitArrangements(
  lines: string[],
  diffs: readonly ArrangementDiff[],
  verbose: boolean,
): void {
  sectionHeader(lines, "Arrangements");
  for (const d of diffs) {
    lines.push(`  ${marker(d.kind)} ${d.humanLabel}`);
    for (const c of d.changes) lines.push(`      ${changeMarker(c)} ${c.humanLabel}`);
    for (const td of d.trackChanges) {
      lines.push(`      ${marker(td.kind)} ${td.humanLabel}`);
      emitTrackChanges(lines, td, verbose);
    }
  }
}

function emitTrackChanges(lines: string[], td: TrackDiff, verbose: boolean): void {
  const hasGroups =
    td.clipMoveGroups.length > 0 ||
    td.clipBulkGroups.length > 0 ||
    td.clipModifyGroups.length > 0;

  if (verbose || !hasGroups) {
    for (const c of td.changes) lines.push(`          ${changeMarker(c)} ${c.humanLabel}`);
    return;
  }

  const covered = new Set<string>();
  for (const g of td.clipMoveGroups) for (const p of g.changePaths) covered.add(p);
  for (const g of td.clipBulkGroups) for (const p of g.changePaths) covered.add(p);
  for (const g of td.clipModifyGroups) for (const p of g.changePaths) covered.add(p);

  for (const g of td.clipMoveGroups) {
    lines.push(`          ${MODIFIED} ${g.humanLabel}`);
  }
  for (const g of td.clipBulkGroups) {
    const m = g.kind === "added" ? ADDED : REMOVED;
    lines.push(`          ${m} ${g.humanLabel}`);
  }
  for (const g of td.clipModifyGroups) {
    lines.push(`          ${MODIFIED} ${g.humanLabel}`);
  }

  for (const c of td.changes) {
    if (covered.has(c.path)) continue;
    lines.push(`          ${changeMarker(c)} ${c.humanLabel}`);
  }
}

function emitOpaques(lines: string[], opaques: readonly OpaqueChange[]): void {
  sectionHeader(lines, "Opaque blobs");
  for (const oc of opaques) lines.push(`  ${MODIFIED} ${oc.humanLabel}`);
}
